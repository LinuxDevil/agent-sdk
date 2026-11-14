/**
 * In-memory registry mapping agent IDs to live runs, tracked by
 * `sessionId`. One `RunEntry` per agent ID - only one live run per agent
 * at a time, matching the app's Run/Stop/Debug buttons which operate on
 * "the currently loaded agent".
 *
 * This is the piece that actually wires start/stop/status and
 * durable-execution resume + approval-gate pause/resume together. The
 * agent path speaks only to the workspace's `AgentHost`
 * (host/agentHost.ts): `host.start()` begins a run, `host.abort()` stops
 * it, `host.resolveApproval()` resumes a paused one, and every event,
 * span and settle arrives on the launch's `onEvent` (see `onHostEvent`).
 * Flow specs (`spec.flow`) are the one exception: they keep the legacy
 * in-process `FlowExecutor` path until flows are spec-v2 (startFlowRun).
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fanOutExporters, fileTraceExporter, type ObserveExporterOptions } from '@linuxdevil/lousho/traces';
import { agentTraceDir } from './traceStore';
import { observeReporting, withoutCapturedContent, type ObserveReporting } from './observeReporting';
import { AgentExecutor } from '@linuxdevil/lousho/executor';
import {
  type AgentEvent,
  type AgentInput,
  type AgentSpecV2,
  type CheckpointStore,
  type Span,
  type TraceExporter,
  type ExecutionResult,
  type Message,
  emptyRunUsage,
  compareTrajectories,
  describeApproval,
  getCheckpointHistory,
  type CheckpointHistoryEntry,
  type ForkPatch,
  type TrajectoryComparison,
} from '@linuxdevil/lousho';
import { FlowExecutor, type AgentFlow } from '@linuxdevil/lousho/flows';
import { buildAgentFromSpec, extractFlowFromSpec } from './buildAgent';
import { toLegacySpec } from './storage/legacySpec';
import { HostRunNotActiveError, type AgentHost, type HostEvent, type HostRunResult } from './host/agentHost';
import { HostUnsupportedError } from './host/hostStatus';
import { withAbortSignal, RunAbortedError } from './abortableProvider';
import { FileApprovalStore } from './approvalStore';
import { approvalDeadline, EXPIRED_APPROVAL_NOTE, NO_ANSWER_TEXT } from './approvalDeadline';
import { autoApprovalLogEntry } from './autoApproval';
import { DebugSession, type BreakpointKey } from './debugController';
import { FileChatStore, previewFor } from './chatStore';
import { markRunInput, markSteerInputs, reconcileChatMessages } from './chatReconcile';
import { toLogEntries, toFlowLogEntries } from './logEntries';
import { nodeStateFor } from './nodeStates';
import type { SecretsStore } from './secretsStore';
import type { SettingsStore } from './settingsStore';
import type {
  AgentRunStatusPayload,
  RunStatus,
  LogEntry,
  LogLevel,
  LogPhase,
  ChatMessage,
  ChatStatePayload,
  SteerInfo,
  SteerResponse,
  ChatSessionMeta,
  ChatSessionRecord,
  RunHistoryStep,
  ToolPin,
} from '../shared/wireTypes';
import { pinnedResultsHook } from './pins';

/** Options for {@link RunManager.run}: what started the run plus this launch's tool pins (T04). */
export interface RunOptions {
  /**
   * `'trigger'` for runs a trigger launched (R08a/R08c/R07 pass it); absent
   * or `'manual'` for Run/chat starts. Carried on the status payload so the
   * failure-streak pass (L12) counts triggered runs only.
   */
  source?: 'manual' | 'trigger';
  /** The trigger that started the run, when `source` is `'trigger'`. */
  triggerId?: string;
  /** The trigger's raw event payload - accepted for the trigger tickets; not stored on the entry. */
  triggerEvent?: unknown;
  /** This launch's pinned tool results (T04 run-from-here); never stored, never sent on chat turns. */
  pins?: ToolPin[];
}

interface RunEntry {
  status: RunStatus;
  /**
   * Stable for the lifetime of this agent id in the registry - always just
   * `agentId` (see run()'s doc comment for why this must NOT change between
   * a stop() and the next run() call).
   */
  sessionId: string;
  controller?: AbortController;
  error?: string;
  reason?: 'awaiting_approval';
  pendingApproval?: AgentRunStatusPayload['pendingApproval'];
  /** When the in-flight run launched (the approval deadline's "remaining run time" bound takes runStartedAt from it). */
  startedAt?: string;
  /**
   * The pending pause's self-resolution timer (unref'd): fires
   * expireDeadline() at `pendingApproval.deadline`. Armed when a pause is
   * recorded, cleared on every resolution path - approve(), answer(),
   * stop() and the next launch.
   */
  deadlineTimer?: NodeJS.Timeout;
  resultText?: string;
  /** The settled run's result (messages/toolCalls/usage/steps/finishReason) for the Output tab's JSON tree. */
  result?: HostRunResult;
  updatedAt: string;
  /**
   * The AgentSpec this agent id was last run() with. approve() needs a spec
   * to rebuild the provider/toolRegistry for the follow-up execute() call
   * but the app doesn't resend one on `POST /agents/:id/approve` - it just
   * resolves the pending decision - so the spec from the run that paused is
   * kept here for reuse. Also used as the loadSpec() fallback's write-through
   * cache is unnecessary since this is already in memory for the lifetime of
   * the process.
   */
  lastSpec?: AgentSpecV2;
  /** `<provider>/<model>` the last run actually used, for the Topbar's env pill. */
  provider?: string;
  /** Root span id of the latest run (its trace id), for the top bar's "Open trace" link. */
  traceId?: string;
  /**
   * The AgentHost run id of the in-flight agent-path run (approve() resolves and
   * stop() aborts through it). Set while the run is live or paused; cleared when
   * it settles not-awaiting-approval, fails, or is aborted. Flow runs have none
   * (they never reach an AgentHost).
   */
  hostRunId?: string;
  /** Which execution path owns the in-flight run: 'agent' (AgentHost) or 'flow' (in-process FlowExecutor). */
  kind?: 'agent' | 'flow';
  /** Live step-through debug session for this agent's in-flight run, if any. */
  debugSession?: DebugSession;
  /**
   * The `input` of the latest `run()` (the top bar's Run), so
   * the user turn it adds is tagged `source: 'run'` in the transcript
   * instead of passing for something the user typed in Chat.
   */
  runInput?: string;
  /**
   * Why the run was cancelled - only ever set on the transition to
   * `status: 'stopped'` (see abort()), surfaced on the status payload as
   * `abortReason` and cleared by the next launch.
   */
  abortReason?: string;
  /**
   * The chat transcript for this agent's CURRENT chat session -
   * reconciled from the real `ExecutionResult.messages` on every run
   * settle (see chatReconcile.ts), plus the just-sent user message pushed
   * optimistically by sendMessage() before the run even starts. Persisted
   * to disk (chatStore) on every change so it survives a server restart.
   */
  messages: ChatMessage[];
  /** Id of the chat session `messages` belongs to - stable across Stop/Run continuations, changes only on newChat(). */
  chatSessionId: string;
  /** When the current chat session started, for its ChatSessionMeta. */
  chatStartedAt: string;
  /**
   * This run's steer messages (`steer()`), oldest first - each starts
   * `delivery: 'queued'` and flips to 'delivered'/'undelivered' on the
   * launch's `steer.joined` HostEvent. Kept (not cleared) after the run
   * settles so the Test pane's list survives until the next launch, which
   * resets it via the `steering: []` patch in startAgentRun/startFlowRun.
   */
  steering?: SteerInfo[];
  /**
   * What started the in-flight/last run (L12): set on launch from
   * `RunOptions.source`, kept through approve()/resume of the same run,
   * cleared by the next launch that passes no source (a manual run).
   */
  source?: 'manual' | 'trigger';
  triggerId?: string;
}

export interface RunManagerOptions {
  baseDir: string;
  checkpointStore: CheckpointStore;
  /** Must be a FileApprovalStore (agent-scoped resolveFor) - see approve(). */
  approvalStore: FileApprovalStore;
  /**
   * Fallback spec loader used when run() is called without an explicit
   * `spec` (e.g. a restarted server resuming via /status polling) - backed
   * by the workspace's AgentRepo, reading `.lousho/agents/<id>.yaml`.
   */
  loadSpec: (agentId: string) => Promise<AgentSpecV2 | undefined>;
  /** Persists a run's spec to disk (AgentRepo.writeSpec, under the agent lock) so it survives a server restart. */
  saveSpec?: (agentId: string, spec: AgentSpecV2) => Promise<void>;
  /**
   * The host the agent path runs through (AgentHost, host/agentHost.ts):
   * `InProcessAgentHost` in the studio; a bridge host for a workspace with
   * its own SDK. Required - RunManager never compiles or streams a spec
   * itself.
   */
  host: AgentHost;
  /** Chat transcript persistence. Defaults to `new FileChatStore(baseDir)` when omitted. */
  chatStore?: FileChatStore;
  /** Stored provider keys - see buildAgent.ts's resolveProviderForSpec(). Omitted (e.g. in older tests) means every real provider type falls back to mock, same as no keys configured. */
  secretsStore?: SecretsStore;
  /** Active settings profile source (hook timeout today; provider/deploy-adapter selection lives on the profile too, for the Settings UI). */
  settingsStore?: SettingsStore;
  /**
   * Report every run to the observe daemon as agent `<agentId>` (see
   * observeReporting.ts): `true` in the studio, or reporter overrides
   * (tests: `url`, `fetchFn`, ...). Omitted, the manager makes no reporter of
   * its own (the SDK's `LOUSHO_OBSERVE` one still applies).
   */
  observe?: true | Partial<ObserveExporterOptions>;
  /**
   * The Studio collector (collector.ts): run reporting reads its
   * `url()`/`token()` per exporter, so a Settings → Collector change
   * repoints new runs without a restart.
   */
  collector?: import('./collector').CollectorSource;
  /**
   * Overrides approvalDeadline.ts's 30 s minimum pause deadline - tests
   * inject a tiny value (e.g. 50 ms) so an unanswered pause resolves
   * itself inside the test. Production callers leave it unset.
   */
  minDeadlineMs?: number;
}

export class AgentNotFoundError extends Error {}
export class AlreadyRunningError extends Error {}
export class NoActiveRunError extends Error {}
/** A steer was aimed at a flow run - FlowExecutor has no input queue to push into. */
export class SteerUnsupportedError extends Error {}
/** A chat message was sent while the run was paused awaiting a tool approval decision - resolve that first via approve(). */
export class ApprovalPendingError extends Error {}

/**
 * The settled run's full message list, with the assistant's final text
 * appended if it isn't already the last message.
 *
 * SDK bug found while wiring this up and FIXED AT THE SOURCE as part of
 * this epic (src/execution/AgentExecutor.ts's no-more-tool-calls exit
 * path now pushes the assistant's final reply onto `currentMessages`
 * before returning, so `result.messages` already includes it). The
 * guard below is kept as a now-provably-redundant safety net rather
 * than removed outright - it only appends when the last message is NOT
 * already that exact assistant/text pair, which is always true against
 * a fixed SDK, so this is a harmless no-op today. Left in case a caller
 * ever runs this app against an older/vendored SDK build that predates
 * the fix.
 */
function authoritativeMessages(result: HostRunResult): Message[] {
  const last = result.messages[result.messages.length - 1];
  const alreadyEndsWithText = last?.role === 'assistant' && last.content === result.text;
  return result.text && !alreadyEndsWithText
    ? [...result.messages, { role: 'assistant', content: result.text }]
    : result.messages;
}

/** Strips the id/timestamp this file adds for the UI, back to the SDK's real `Message` shape for feeding into AgentExecutor.execute(). */
function toSdkMessage(m: ChatMessage): Message {
  return {
    role: m.role,
    content: m.content,
    name: m.name,
    toolCallId: m.toolCallId,
    toolName: m.toolName,
    toolCalls: m.toolCalls,
  };
}

/** A history entry as the History panel lists it. */
function toHistoryStep({ step, status, savedAt, checkpoint }: CheckpointHistoryEntry): RunHistoryStep {
  const call = checkpoint.stepUsage?.filter((usage) => usage.step === step).at(-1);
  // The step's model turn is the transcript's last assistant message.
  const toolCalls = compareTrajectories(checkpoint, []).a.at(-1)?.tools ?? [];
  return {
    step,
    status,
    savedAt,
    // checkpoint.finishReason is the previous step's while this one's tool calls run.
    finishReason: toolCalls.length > 0 ? 'tool_calls' : checkpoint.finishReason,
    toolCalls,
    ...(call && { tokens: call.usage.totalTokens, costUsd: call.costUsd }),
  };
}

export class RunManager extends EventEmitter {
  private readonly entries = new Map<string, RunEntry>();
  /**
   * Breakpoints persist per agent id across runs (set them once, they
   * apply to every future run() until cleared/changed), independent of the
   * in-flight `RunEntry.debugSession` - a fresh DebugSession is created
   * per-run() but seeded from this map.
   */
  private readonly breakpoints = new Map<string, Set<BreakpointKey>>();
  /** Chat transcript persistence (see chatStore.ts). */
  private readonly chatStore: FileChatStore;
  /** One observe reporter per agent id, made on its first run. */
  private readonly reporting = new Map<string, ObserveReporting>();

  constructor(private readonly opts: RunManagerOptions) {
    super();
    this.setMaxListeners(0);
    this.chatStore = opts.chatStore ?? new FileChatStore(opts.baseDir);
  }

  status(agentId: string): AgentRunStatusPayload {
    const entry = this.entries.get(agentId);
    if (!entry) {
      return { agentId, status: 'idle', updatedAt: new Date().toISOString() };
    }
    return {
      agentId,
      status: entry.status,
      sessionId: entry.sessionId,
      reason: entry.reason,
      pendingApproval: entry.pendingApproval,
      error: entry.error,
      resultText: entry.resultText,
      result: entry.result,
      provider: entry.provider,
      traceId: entry.traceId,
      abortReason: entry.abortReason,
      steering: entry.steering,
      source: entry.source,
      triggerId: entry.triggerId,
      updatedAt: entry.updatedAt,
    };
  }

  /** True while any agent's run is 'running' or 'paused' - `WorkspaceManager.sweep()` keeps a context warm on this. */
  hasActiveRun(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.status === 'running' || entry.status === 'paused') return true;
    }
    return false;
  }

  private setEntry(agentId: string, patch: Partial<RunEntry>, base?: RunEntry): RunEntry {
    const prev =
      base ??
      this.entries.get(agentId) ??
      this.freshEntry(agentId);
    const next: RunEntry = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    this.entries.set(agentId, next);
    this.emit('status', this.status(agentId));
    return next;
  }

  private freshEntry(agentId: string): RunEntry {
    const now = new Date().toISOString();
    // A brand-new (never-touched-this-process) agent id picks up any
    // chat transcript persisted under its default session id (`agentId`
    // itself, mirroring AgentExecutor's `sessionId = agentId`) from a
    // previous server run, so chat history survives a restart the same way
    // saved agent specs do.
    //
    // Known limitation: if the LAST thing that happened before the restart
    // was a newChat() (which moves the live session to a fresh randomUUID()
    // id), that new session id isn't recovered here - only the default
    // `agentId`-named session is. A restart in that state resumes the
    // agent's FIRST session rather than whichever one was live; every
    // session is still fully intact and browsable via listChats()/
    // loadChatSession(), just not auto-selected as "current". Left for
    // A small "current session pointer" file would close this gap.
    const persisted = this.chatStore.load(agentId, agentId);
    return {
      status: 'idle' as RunStatus,
      sessionId: agentId,
      updatedAt: now,
      messages: persisted?.messages ?? [],
      chatSessionId: agentId,
      chatStartedAt: persisted?.startedAt ?? now,
    };
  }

  /** Current live chat transcript for `agentId` (creates no run - safe to call for an agent that has never run). */
  chatState(agentId: string): ChatStatePayload {
    const entry = this.entries.get(agentId) ?? this.freshEntry(agentId);
    return { agentId, sessionId: entry.chatSessionId, messages: entry.messages };
  }

  /** Metadata for every persisted chat session for `agentId` (including the current one, once it has been saved at least once). */
  listChats(agentId: string): ChatSessionMeta[] {
    return this.chatStore.list(agentId);
  }

  /** A full past (or current) chat session's transcript, or undefined if unknown. */
  loadChatSession(agentId: string, sessionId: string): ChatSessionRecord | undefined {
    return this.chatStore.load(agentId, sessionId) ?? undefined;
  }

  private persistChat(agentId: string, entry: RunEntry): void {
    const now = new Date().toISOString();
    this.chatStore.save(agentId, {
      sessionId: entry.chatSessionId,
      startedAt: entry.chatStartedAt,
      updatedAt: now,
      messageCount: entry.messages.length,
      preview: previewFor(entry.messages),
      messages: entry.messages,
    });
  }

  private emitChat(agentId: string, entry: RunEntry): void {
    this.persistChat(agentId, entry);
    this.emit('chat', agentId, { agentId, sessionId: entry.chatSessionId, messages: entry.messages } satisfies ChatStatePayload);
  }

  /**
   * Archives the current chat session (already persisted incrementally
   * by every prior emitChat() call, so this is really just "cut a new
   * session going forward") and starts a fresh, empty one for `agentId`.
   * Does not touch any in-flight run - starting a new chat while a run is
   * in progress is allowed (the in-flight run keeps writing to whatever
   * session it started under; sendMessage() rejects new input meanwhile
   * regardless of which session id is "current").
   */
  newChat(agentId: string): ChatStatePayload {
    const now = new Date().toISOString();
    const next = this.setEntry(agentId, {
      messages: [],
      chatSessionId: randomUUID(),
      chatStartedAt: now,
    });
    this.persistChat(agentId, next);
    return this.chatState(agentId);
  }

  private emitEvent(agentId: string, event: AgentEvent): void {
    this.emit('event', agentId, event);
    for (const log of toLogEntries(agentId, event)) {
      this.emit('log', agentId, log);
    }
  }

  /**
   * Forwards one span start/end notification as a `span` frame, then -
   * when the span carries `lousho.node.id` - the `node` frame it implies
   * (nodeStates.ts), so a canvas client always sees the node state right
   * after the span it was derived from. `phase` is which exporter hook
   * fired (start vs end), the only thing that decides running-vs-done.
   */
  private emitSpan(agentId: string, span: Span, phase: 'start' | 'end'): void {
    this.emit('span', agentId, {
      id: span.id,
      name: span.name,
      parentId: span.parentId,
      startTime: span.startTime,
      endTime: span.endTime,
      attributes: span.attributes,
      ...(span.kind !== undefined && { kind: span.kind }),
      ...(span.status !== undefined && { status: span.status }),
    });
    const node = nodeStateFor(span, phase, new Date());
    if (node !== undefined) this.emit('node', agentId, node);
  }

  /**
   * Builds a `TraceExporter` (src/execution/tracing.ts) that forwards
   * every real span start/end notification for this run over the existing
   * WS channel (as `{type:'span', ...}` messages, see wsServer.ts) rather
   * than a second tracing pipeline. It also writes the run to the
   * agent's trace folder (see traceStore.ts), so the Trace tab can reopen it,
   * and reports it to the observe daemon when `observe` is set (captured
   * content goes to that reporter only). The root span's id is the run's
   * trace id, kept on the status.
   */
  private makeTraceExporter(agentId: string): TraceExporter {
    const live: TraceExporter = {
      onSpanStart: (span) => {
        if (span.parentId === undefined) this.setEntry(agentId, { traceId: span.id });
        this.emitSpan(agentId, span, 'start');
      },
      onSpanEnd: (span) => this.emitSpan(agentId, span, 'end'),
    };
    const file = fileTraceExporter({ dir: agentTraceDir(this.opts.baseDir, agentId) });
    // Content captured for a loopback daemon is for the reporter alone: the
    // trace file and the live feed see each span without it.
    const local = this.captureContentFor(agentId) ? [live, file].map(withoutCapturedContent) : [live, file];
    // The SDK's fan-out, so AgentExecutor sees an env reporter in it and adds none of its own.
    return fanOutExporters([...local, this.reportingFor(agentId)?.exporter()]) as TraceExporter;
  }

  private reportingFor(agentId: string): ObserveReporting | undefined {
    const { observe } = this.opts;
    if (!observe) return undefined;
    let reporting = this.reporting.get(agentId);
    if (!reporting) {
      reporting = observeReporting({
        agentName: agentId,
        baseDir: this.opts.baseDir,
        ...(observe === true ? {} : { overrides: observe }),
        ...(this.opts.collector ? { collector: this.opts.collector } : {}),
      });
      this.reporting.set(agentId, reporting);
    }
    return reporting;
  }

  /** Content goes on the run's spans only when its reporter's target is loopback; `undefined` keeps the SDK default. */
  private captureContentFor(agentId: string): boolean | undefined {
    return this.reportingFor(agentId)?.captureContent();
  }

  /** (re)creates the debug session for a fresh run(), seeded from this agent's persisted breakpoints. */
  private makeDebugSession(agentId: string): DebugSession {
    const initial = this.breakpoints.get(agentId) ?? new Set<BreakpointKey>();
    const session = new DebugSession(initial, (state) => {
      this.emit('debug', agentId, { agentId, ...state });
      if (state.paused) {
        this.emit('log', agentId, {
          id: randomUUID(),
          agentId,
          timestamp: new Date().toISOString(),
          level: 'info' as LogLevel,
          phase: 'debug' as LogPhase,
          message: `Paused at breakpoint ${state.atBreakpoint?.phase} (${state.atBreakpoint?.boundary})`,
        } satisfies LogEntry);
      } else if (state.autoResumed) {
        // Debugger safety net: nobody called continue()/step() before
        // DEFAULT_PAUSE_TIMEOUT_MS elapsed (most plausibly the only WS
        // client watching this run disconnected while it was paused) - see
        // debugController.ts's DEFAULT_PAUSE_TIMEOUT_MS doc comment.
        this.emit('log', agentId, {
          id: randomUUID(),
          agentId,
          timestamp: new Date().toISOString(),
          level: 'warn' as LogLevel,
          phase: 'debug' as LogPhase,
          message: 'Auto-resumed after sitting paused at a breakpoint with no client response',
        } satisfies LogEntry);
      }
    });
    return session;
  }

  /**
   * Starts (or resumes) a run for `agentId`.
   *
   * `sessionId` is always just `agentId` - stable across every run() call
   * for this agent id, including a run() that follows a stop(). This is
   * what makes Stop-then-Run resume from the last checkpoint instead
   * of starting over: AgentExecutor.execute() (see its doc comments)
   * rehydrates from `checkpointStore.load(sessionId)` when a checkpoint
   * exists under that id, and only marks it 'finished' on a *successful*
   * terminal completion - never when the run was aborted (see
   * abortableProvider.ts). So after a stop(), the unfinished checkpoint is
   * still there, and the very next run() call for this agentId picks it
   * back up automatically.
   *
   * `input` is appended to the rehydrated conversation as a new
   * user turn (after the interrupted turn's pending tool results), unless
   * it re-sends the message the interrupted run started from; after a
   * finished run it continues the conversation.
   */
  async run(
    agentId: string,
    input: string,
    spec?: AgentSpecV2,
    options?: RunOptions
  ): Promise<void> {
    const existing = this.entries.get(agentId);
    if (existing && existing.status === 'running') {
      throw new AlreadyRunningError(`Agent '${agentId}' is already running`);
    }
    await this.launch(agentId, input, spec, { runInput: input, ...options });
  }

  /**
   * `POST /agents/:id/message` - appends a chat message to the agent's
   * conversation and either continues it (if this agent has any prior chat
   * history) or starts a brand-new one, replying over the existing
   * `WS /agents/:id/stream` channel as `{type:'chat', ...}` events rather
   * than a new one.
   *
   * Continuation semantics (the "your call which" from the epic brief):
   * - A run already in flight for this agent -> rejected (AlreadyRunningError,
   *   surfaced as 409). A chat message while the agent is mid-turn has
   *   nowhere sensible to go until that turn finishes; the input box stays
   *   disabled client-side while `status === 'running'` for the same reason.
   * - Paused awaiting a tool approval -> rejected (ApprovalPendingError,
   *   409). The approval card rendered inline in the thread is the only
   *   valid next step; free-text chat can't resolve a pending tool call.
   * - Otherwise (idle/stopped/error, i.e. no run currently owns this
   *   agent's conversation): if this agent has ANY prior chat messages,
   *   the new message CONTINUES that exact conversation - the run's
   *   `Message[]` minus the id/timestamp fields this file adds for the UI,
   *   and minus its 'system' entry (createAgent injects the system prompt
   *   itself, so there is exactly one system message in the continued
   *   history) plus the new user turn, passed as `input` to `host.start()`.
   *   A genuinely new agent (no prior chat) passes the plain string
   *   instead, so the normal message build runs exactly like a Topbar
   *   "Run" click.
   *
   * The checkpoint under this agent's sessionId already holds that same
   * history; the durable run recognises the re-sent prefix and appends
   * only the new user turn - after a Stop mid-flight, once the
   * interrupted turn's pending tool results are recorded.
   */
  async sendMessage(agentId: string, text: string, spec?: AgentSpecV2): Promise<void> {
    const existing = this.entries.get(agentId) ?? this.freshEntry(agentId);
    if (existing.status === 'running') {
      throw new AlreadyRunningError(`Agent '${agentId}' is already running`);
    }
    if (existing.status === 'paused' && existing.reason === 'awaiting_approval') {
      throw new ApprovalPendingError(
        `Agent '${agentId}' is paused awaiting an approval decision - resolve it via approve() before sending another message`
      );
    }

    const now = new Date().toISOString();
    const userMessage: ChatMessage = { role: 'user', content: text, id: randomUUID(), timestamp: now };
    const priorMessages = existing.messages;
    const withUser = this.setEntry(agentId, { messages: [...priorMessages, userMessage] }, existing);
    this.emitChat(agentId, withUser);

    // A continued chat passes the prior messages WITHOUT their 'system'
    // entry plus the new user message - createAgent injects the system
    // prompt itself, so there is exactly one system message in the result.
    const prior = priorMessages.map(toSdkMessage).filter((m) => m.role !== 'system');
    const input: AgentInput = prior.length > 0 ? [...prior, toSdkMessage(userMessage)] : text;

    try {
      await this.launch(agentId, input, spec, {});
    } catch (error) {
      // The run never started (no spec, provider not configured): take the user's message back out of the transcript so a
      // retry after fixing it doesn't send it twice.
      const current = this.entries.get(agentId);
      if (current) this.emitChat(agentId, this.setEntry(agentId, { messages: priorMessages }, current));
      throw error;
    }
  }

  /**
   * `POST /agents/:id/steer` - pushes `message` into the live run's input
   * queue through the AgentHost (`host.steer(entry.hostRunId, ...)`, the
   * D12b seam - never `entry.run`, which no longer exists). The message
   * reaches the model after its next tool call or step boundary; whether
   * it actually joined the transcript arrives later as the launch's
   * `steer.joined` HostEvent (see onHostEvent), which flips the SteerInfo's
   * `delivery` queued -> delivered/undelivered.
   *
   * Errors: NoActiveRunError when nothing is running for this agent (or
   * the run ended between the status check and the host call -
   * `HostRunNotActiveError`/`applied === false` both map to it), and
   * SteerUnsupportedError for flow runs, which have no input queue.
   */
  async steer(agentId: string, message: string): Promise<SteerResponse> {
    const entry = this.entries.get(agentId);
    if (!entry || entry.status !== 'running') {
      throw new NoActiveRunError('Nothing is running, so there is nothing to steer.');
    }
    if (entry.kind === 'flow') {
      throw new SteerUnsupportedError('Flow runs cannot be steered yet.');
    }
    if (entry.hostRunId === undefined) {
      throw new NoActiveRunError('Nothing is running, so there is nothing to steer.');
    }

    const hostRunId = entry.hostRunId;
    let result;
    try {
      result = await this.opts.host.steer(hostRunId, message);
    } catch (error) {
      if (error instanceof HostRunNotActiveError) {
        throw new NoActiveRunError('Nothing is running, so there is nothing to steer.');
      }
      throw error;
    }
    if (result.applied === false) {
      // The run ended between the status check and the host call.
      throw new NoActiveRunError('Nothing is running, so there is nothing to steer.');
    }

    const info: SteerInfo = {
      id: result.id,
      message,
      at: new Date().toISOString(),
      delivery: 'queued',
      mode: result.applied,
    };
    const current = this.entries.get(agentId);
    // The run may have settled AND a new one launched during the await -
    // the entry existing is not enough: without the hostRunId check run1's
    // SteerInfo would land in run2's `steering` list (and run2's launch
    // reset would never clear it again).
    if (current !== undefined && current.hostRunId === hostRunId) {
      this.setEntry(agentId, { steering: [...(current.steering ?? []), info] });
    }
    return { id: result.id, applied: result.applied };
  }

  /** Picks the spec to run: the supplied one (persisted if a saveSpec hook exists), else the last-run one, else the saved one. */
  private async resolveLaunchSpec(
    agentId: string,
    spec: AgentSpecV2 | undefined,
    existing: RunEntry | undefined
  ): Promise<AgentSpecV2> {
    const resolvedSpec = spec ?? existing?.lastSpec ?? (await this.opts.loadSpec(agentId));
    if (!resolvedSpec) {
      throw new AgentNotFoundError(`No agent spec for id '${agentId}' (none supplied and none saved)`);
    }
    if (spec && this.opts.saveSpec) {
      await this.opts.saveSpec(agentId, spec);
    }
    return resolvedSpec;
  }

  /**
   * Shared run-kickoff for both run() and sendMessage() - resolves the
   * spec, then dispatches: a spec with a `flow` goes to the in-process
   * FlowExecutor path (startFlowRun); every other spec goes through the
   * workspace's AgentHost (startAgentRun - see host/agentHost.ts for why
   * RunManager never compiles or streams a spec itself).
   */
  private async launch(
    agentId: string,
    input: AgentInput,
    spec?: AgentSpecV2,
    options: { runInput?: string; source?: 'manual' | 'trigger'; triggerId?: string; triggerEvent?: unknown; pins?: ToolPin[] } = {}
  ): Promise<void> {
    const existing = this.entries.get(agentId);
    const resolvedSpec = await this.resolveLaunchSpec(agentId, spec, existing);
    const legacySpec = toLegacySpec(resolvedSpec);
    const flow = extractFlowFromSpec(legacySpec);
    if (flow) {
      // W11c: the flow path is Studio's own in-process FlowExecutor - on a
      // bridge workspace that would silently bypass the project's SDK, so
      // refuse until the bridge protocol carries flows (protocol 2).
      if (this.opts.host.kind === 'bridge') {
        throw new HostUnsupportedError(
          "Flow runs need Studio's built-in SDK for now. Remove the project's SDK from this workspace or run the flow from code."
        );
      }
      return this.startFlowRun(agentId, flow, resolvedSpec, legacySpec, existing, options);
    }
    return this.startAgentRun(agentId, input, resolvedSpec, existing, options);
  }

  /**
   * The agent path: `host.start()` compiles the spec and begins the run -
   * awaited BEFORE `setEntry('running')`, since a spec that cannot be
   * built (bad provider, missing key, unresolved tool ref) rejects before
   * any event and must never leave a stuck 'running'. Everything after
   * that (events, spans, the settle) arrives on `onHostEvent`.
   */
  private async startAgentRun(
    agentId: string,
    input: AgentInput,
    resolvedSpec: AgentSpecV2,
    existing: RunEntry | undefined,
    options: { runInput?: string; source?: 'manual' | 'trigger'; triggerId?: string; pins?: ToolPin[] }
  ): Promise<void> {
    const sessionId = agentId;
    const debugSession = this.makeDebugSession(agentId);
    const exporter = this.makeTraceExporter(agentId);
    // The launch's own run id, filled in once host.start() resolves, so a
    // late event of a REPLACED run (a settled after a new launch) can be
    // told apart by comparing the entry's hostRunId - see onHostEvent.
    const live = { runId: undefined as string | undefined, exporter };
    const { runId, modelLabel } = await this.opts.host.start({
      agentId,
      spec: resolvedSpec,
      sessionId,
      input,
      captureContent: this.captureContentFor(agentId),
      // The debugger hook first, then this run's pins (T04): a pinned tool
      // call resolves to its recorded result without executing - for this
      // launch only, never stored and never sent on chat turns.
      extraHooks: [
        ...debugSession.agentHooks(),
        ...(options.pins !== undefined && options.pins.length > 0 ? [pinnedResultsHook(options.pins)] : []),
      ],
      onEvent: (event) => this.onHostEvent(agentId, event, live),
      // R01b: every auto-approval decision becomes an 'approval'-phase Logs row.
      onAutoApproval: (decision) => this.emit('log', agentId, autoApprovalLogEntry(agentId, decision)),
    });
    live.runId = runId;
    this.setEntry(
      agentId,
      {
        status: 'running',
        sessionId,
        controller: undefined,
        error: undefined,
        reason: undefined,
        pendingApproval: undefined,
        deadlineTimer: this.clearDeadlineTimer(existing),
        startedAt: new Date().toISOString(),
        resultText: undefined,
        traceId: undefined,
        abortReason: undefined,
        runInput: options.runInput,
        lastSpec: resolvedSpec,
        provider: modelLabel,
        debugSession,
        hostRunId: runId,
        kind: 'agent',
        steering: [],
        // `undefined` on a manual/chat launch clears a previous trigger
        // run's source (L12); a trigger launch stamps both fields.
        source: options.source,
        triggerId: options.triggerId,
      },
      existing
    );
  }

  /** One HostEvent of a launch: forwarded to the same status/chat/log/span broadcasts the SDK used to drive directly. */
  private onHostEvent(agentId: string, event: HostEvent, live: { runId: string | undefined; exporter: TraceExporter }): void {
    // A steer.joined is matched by steer id against the entry's `steering`
    // list - NOT by run id - because `joined` resolves only once the input
    // lands (or the run ends), which can be after 'settled' already cleared
    // `hostRunId`. A stale run's steer id simply isn't in the list (launch
    // resets it), so this stays safe without the guard below.
    if (event.type === 'steer.joined') {
      this.onSteerJoined(agentId, event.steerId, event.joined);
      return;
    }
    // A run id that is no longer on the entry (a settled that landed after
    // a newer launch) is dropped - except while the launch is still inside
    // host.start() (runId not yet assigned).
    const entry = this.entries.get(agentId);
    if (live.runId !== undefined && entry?.hostRunId !== live.runId) return;
    switch (event.type) {
      case 'agent':
        this.emitEvent(agentId, event.event);
        return;
      case 'span':
        if (event.phase === 'start') live.exporter.onSpanStart?.(event.span);
        else live.exporter.onSpanEnd?.(event.span);
        return;
      case 'settled':
        void this.handleRunSettled(agentId, event.result);
        return;
      case 'failed':
        this.handleRunFailed(agentId, Object.assign(new Error(event.error.message), event.error));
        return;
    }
  }

  /**
   * A `steer.joined` HostEvent: flips the matching SteerInfo's `delivery`
   * queued -> delivered/undelivered. Idempotent (only a still-'queued' item
   * moves) and a no-op when the id isn't on the entry - e.g. a steer of a
   * run a newer launch already replaced.
   */
  private onSteerJoined(agentId: string, steerId: string, joined: boolean): void {
    const entry = this.entries.get(agentId);
    const steering = entry?.steering;
    if (entry === undefined || steering === undefined || !steering.some((s) => s.id === steerId)) return;
    this.setEntry(agentId, {
      steering: steering.map((s) =>
        s.id === steerId && s.delivery === 'queued'
          ? { ...s, delivery: joined ? ('delivered' as const) : ('undelivered' as const) }
          : s
      ),
    });
  }

  /**
   * Runs a branching graph's compiled `AgentFlow` through
   * `FlowExecutor.execute()` instead of the AgentHost agent path
   * (`spec.flow` is a pending section - flows keep the legacy
   * buildAgentFromSpec wiring until S21). The spec is built BEFORE
   * `setEntry('running')` for the same reason as startAgentRun.
   *
   * Known, DELIBERATE gaps vs. the agent path (see this ticket's
   * report for the full writeup - not silently papered over):
   *  - No checkpointStore/approvalStore: `FlowExecutor` has no
   *    pause/resume or human-in-the-loop-approval primitive at all, so a
   *    branching run cannot pause for approval and Stop-then-Run cannot
   *    resume it from a mid-flight checkpoint the way a flat-spec run can -
   *    it always runs to completion or failure in one call.
   *  - No hooks/sandbox-gated tool calls beyond `requiresSandbox` itself:
   *    `FlowExecutor.executeToolCall()` does route through the same
   *    `executeToolWithSandboxGuard()` seam, but there is no `hooks`
   *    parameter at all, so pre/post hooks attached to a node never
   *    fire on a branching run.
   *  - Debug console: logs only, not trace spans or step-debugger
   *    breakpoints - see `toFlowLogEntries()`'s doc comment in logEntries.ts.
   */
  private async startFlowRun(
    agentId: string,
    flow: AgentFlow,
    resolvedSpec: AgentSpecV2,
    legacySpec: import('@linuxdevil/lousho').AgentSpec,
    existing: RunEntry | undefined,
    options: { runInput?: string; source?: 'manual' | 'trigger'; triggerId?: string }
  ): Promise<void> {
    const { agent, provider, toolRegistry, sandbox } = buildAgentFromSpec(legacySpec, agentId, undefined, {
      secretsStore: this.opts.secretsStore,
      hookTimeoutMs: this.opts.settingsStore?.activeProfile().hookTimeoutMs,
    });
    const sessionId = agentId;
    const controller = new AbortController();
    const debugSession = this.makeDebugSession(agentId);
    this.setEntry(
      agentId,
      {
        status: 'running',
        sessionId,
        controller,
        error: undefined,
        reason: undefined,
        pendingApproval: undefined,
        deadlineTimer: this.clearDeadlineTimer(existing),
        startedAt: new Date().toISOString(),
        resultText: undefined,
        traceId: undefined,
        abortReason: undefined,
        runInput: options.runInput,
        lastSpec: resolvedSpec,
        provider: `${provider.name}/${legacySpec.provider.model}`,
        debugSession,
        hostRunId: undefined,
        kind: 'flow',
        steering: [],
        source: options.source,
        triggerId: options.triggerId,
      },
      existing
    );

    FlowExecutor.execute(
      flow,
      {
        agent,
        provider: withAbortSignal(provider, controller.signal),
        toolRegistry,
        variables: {},
        sandbox,
        signal: controller.signal,
      },
      (event) => {
        for (const log of toFlowLogEntries(agentId, event)) {
          this.emit('log', agentId, log);
        }
      }
    )
      .then((flowResult) => {
        const text =
          typeof flowResult.output === 'string' ? flowResult.output : JSON.stringify(flowResult.output ?? null);
        if (!flowResult.success) {
          this.handleRunFailed(agentId, flowResult.error ?? new Error('Flow run failed'));
          return;
        }
        // Forged into the same `ExecutionResult` shape `handleRunSettled()`
        // already knows how to reconcile into the chat transcript/Output
        // tab - `FlowExecutor` has no per-message conversation model
        // (`context.variables`, not `Message[]`), so this is a single
        // synthetic assistant turn carrying the flow's final output.
        const result: ExecutionResult = {
          text,
          messages: [{ role: 'assistant', content: text }],
          toolCalls: [],
          usage: emptyRunUsage(),
          finishReason: 'stop',
          steps: flowResult.steps,
        };
        void this.handleRunSettled(agentId, result);
      })
      .catch((error: unknown) => this.handleRunFailed(agentId, error));
  }

  /** Shared success-path handling: a host run's 'settled' event, or the FlowExecutor path's forged result. */
  private async handleRunSettled(agentId: string, result: HostRunResult): Promise<void> {
    // Reconcile the chat transcript against the real, authoritative
    // ExecutionResult.messages - see chatReconcile.ts's doc comment for why
    // this (rather than building the transcript incrementally from
    // AgentEvents) is the single source of truth. Done for BOTH the
    // completed and paused-for-approval branches below, since both hand
    // back a full `messages` array (the pause happens exactly at the point
    // the assistant's tool-call message was added).
    const settledAt = new Date().toISOString();
    const entryBefore = this.entries.get(agentId);
    const prevMessages = entryBefore?.messages ?? [];
    const reconciled = reconcileChatMessages(prevMessages, authoritativeMessages(result), settledAt);
    // Steer deliveries are final by now: the input queue resolves every
    // pending `joined` (false for whatever never landed) before the run's
    // result does, so each `steer.joined` HostEvent already flipped the
    // SteerInfo - 'delivered' ones tag their transcript bubble 'steer',
    // 'undelivered' ones get a warn log line.
    const steering = entryBefore?.steering ?? [];
    const reconciledMessages = markSteerInputs(
      markRunInput(reconciled, prevMessages, entryBefore?.runInput),
      prevMessages,
      steering
    );
    for (const item of steering) {
      if (item.delivery !== 'undelivered') continue;
      this.emit('log', agentId, {
        id: randomUUID(),
        agentId,
        timestamp: settledAt,
        level: 'warn' as LogLevel,
        phase: 'trigger' as LogPhase,
        message: 'Steering message not delivered: the run ended first.',
        detail: { id: item.id, message: item.message },
      } satisfies LogEntry);
    }

    // The full ExecutionResult (messages/toolCalls/usage/steps, not
    // just the final text) is kept on the entry either way, so the
    // client's Output tab can render it as a JSON tree whether the run
    // finished or is paused for approval - "the final OR paused
    // ExecutionResult" per the epic brief.
    if (result.finishReason === 'awaiting-approval' && result.approvalId) {
      this.recordPause(agentId, result, result.approvalId, entryBefore, reconciledMessages);
      return;
    }
    const aborted = result.finishReason === 'aborted';
    const next = this.setEntry(agentId, {
      status: aborted ? 'stopped' : 'done',
      resultText: result.text,
      result,
      controller: undefined,
      hostRunId: undefined,
      // The SDK reports the abort's reason as `{ name, message }` - the
      // message is the string abort() passed through (e.g. 'user',
      // 'abort_listener:<id>').
      abortReason: aborted ? result.abortReason?.message : undefined,
      deadlineTimer: this.clearDeadlineTimer(entryBefore),
      messages: reconciledMessages,
    });
    this.emitChat(agentId, next);
  }

  /**
   * The `awaiting-approval` settle: records the pause (kind, question,
   * subagent path) with the deadline Studio resolves it at itself, and
   * arms the self-resolution timer. The host already read the pause it
   * filed through the scoped store and passed it on the settled result -
   * no second store read here. `describeApproval` normalizes it: an
   * `ask_question` call's raw record has no `kind`/`question` yet (both
   * are derived from its tool name and args); a 'sign-in' pause keeps
   * 'tool' on the wire.
   */
  private recordPause(
    agentId: string,
    result: HostRunResult,
    approvalId: string,
    entryBefore: RunEntry | undefined,
    reconciledMessages: ChatMessage[]
  ): void {
    const pending = result.pendingApproval ? describeApproval(result.pendingApproval) : undefined;
    const kind = pending?.kind === 'question' ? ('question' as const) : ('tool' as const);
    const now = Date.now();
    // The deadline Studio resolves the pause at itself: min(the SDK's
    // expiresAt, the run's own end) - the ask_question tool takes no
    // timeout argument, so there is no "requested" input (PLAN gap).
    const deadline = approvalDeadline({
      now,
      expiresAt: pending?.expiresAt,
      runStartedAt: Date.parse(entryBefore?.startedAt ?? '') || now,
      maxDurationMs: entryBefore?.lastSpec?.limits?.maxDurationMs,
      minDeadlineMs: this.opts.minDeadlineMs,
    });
    this.clearDeadlineTimer(entryBefore);
    const next = this.setEntry(agentId, {
      status: 'paused',
      reason: 'awaiting_approval',
      pendingApproval: {
        approvalId,
        toolName: pending?.toolName ?? 'unknown',
        args: pending?.args ?? {},
        createdAt: pending?.createdAt ?? new Date(now).toISOString(),
        kind,
        ...(kind === 'question' && pending?.question !== undefined && { question: pending.question }),
        deadline,
        ...(pending?.subagentPath !== undefined && { subagentPath: pending.subagentPath }),
      },
      deadlineTimer: this.armDeadline(agentId, approvalId, kind, deadline),
      result,
      messages: reconciledMessages,
    });
    this.emitChat(agentId, next);
  }

  /** Shared failure-path handling: a host run's 'failed' event, or a flow/execute() rejection. */
  private handleRunFailed(agentId: string, error: unknown): void {
    const entry = this.entries.get(agentId);
    // A user-initiated abort is a deliberate terminal state, not an error:
    // the flow path surfaces it either as RunAbortedError (the provider
    // wrapper's check) or as the controller signal's own reason
    // (FlowExecutor's `signal.throwIfAborted()` rethrows it verbatim).
    if (error instanceof RunAbortedError || entry?.controller?.signal.aborted) {
      const signalReason: unknown = entry?.controller?.signal.reason;
      const abortReason =
        signalReason instanceof DOMException
          ? signalReason.message
          : typeof signalReason === 'string'
            ? signalReason
            : undefined;
      this.setEntry(agentId, {
        status: 'stopped',
        controller: undefined,
        hostRunId: undefined,
        abortReason,
        deadlineTimer: this.clearDeadlineTimer(entry),
      });
      return;
    }
    this.setEntry(agentId, {
      status: 'error',
      error: (error as Error)?.message ?? String(error),
      controller: undefined,
      hostRunId: undefined,
      deadlineTimer: this.clearDeadlineTimer(entry),
    });
  }

  /** Clears `entry`'s pause timer if one is armed; returns `undefined` so callers can write `deadlineTimer:` patches inline. */
  private clearDeadlineTimer(entry: RunEntry | undefined): undefined {
    if (entry?.deadlineTimer !== undefined) clearTimeout(entry.deadlineTimer);
    return undefined;
  }

  /**
   * Arms the pause's self-resolution timer at `deadline` (unref'd, so it
   * never holds the process or a test open). First answer wins: a timer
   * that fires after approve()/answer() resolved the pause is a no-op via
   * expireDeadline()'s still-pending check.
   */
  private armDeadline(
    agentId: string,
    approvalId: string,
    kind: 'tool' | 'question',
    deadline: string
  ): NodeJS.Timeout {
    const timer = setTimeout(
      () => this.expireDeadline(agentId, approvalId, kind),
      Math.max(0, Date.parse(deadline) - Date.now())
    );
    timer.unref();
    return timer;
  }

  /**
   * The deadline firing: if this pause is still pending, the run resolves
   * without a human - a question is answered for the model with
   * NO_ANSWER_TEXT, a tool approval is denied with EXPIRED_APPROVAL_NOTE -
   * and the run continues, warned about in the log feed.
   */
  private expireDeadline(agentId: string, approvalId: string, kind: 'tool' | 'question'): void {
    const entry = this.entries.get(agentId);
    if (entry?.status !== 'paused' || entry.pendingApproval?.approvalId !== approvalId) return;
    this.emit('log', agentId, {
      id: randomUUID(),
      agentId,
      timestamp: new Date().toISOString(),
      level: 'warn' as LogLevel,
      phase: 'approval' as LogPhase,
      message: 'Nobody answered before the deadline; the run continued without an answer.',
    } satisfies LogEntry);
    const resolved =
      kind === 'question'
        ? this.answer(agentId, approvalId, NO_ANSWER_TEXT)
        : this.approve(agentId, approvalId, false, EXPIRED_APPROVAL_NOTE);
    resolved.catch((error: unknown) =>
      // A human deciding in the same instant already won (the still-pending
      // check above passed, then their call landed first) - that 409 is
      // noise; anything else is worth a log line.
      this.emit('log', agentId, {
        id: randomUUID(),
        agentId,
        timestamp: new Date().toISOString(),
        level: 'error' as LogLevel,
        phase: 'approval' as LogPhase,
        message: `The deadline fired but the pause could not be resolved: ${(error as Error)?.message ?? String(error)}`,
      } satisfies LogEntry)
    );
  }

  /**
   * Cancels the in-flight run for `agentId` (`POST /agents/:id/abort`).
   *
   * - Running agent path: `host.abort(hostRunId, reason)` aborts the live
   *   run; the `settled` event that follows (`finishReason: 'aborted'`)
   *   maps to `status: 'stopped'` with `abortReason` in handleRunSettled.
   * - Running flow path: the entry's AbortController is aborted with the
   *   reason; the flow fails and handleRunFailed maps the abort (the
   *   signal's own `aborted` state, not just RunAbortedError) to 'stopped',
   *   not 'error'.
   * - Paused on an approval: `host.abort()` discards the pending approval
   *   itself (InProcessAgentHost resolves/deletes the pause file; a bridge
   *   host deletes its own) and emits NO event, so the entry is marked
   *   'stopped' directly once the call returns - a paused run must never
   *   wait for a settle that never comes. Flows cannot pause, so a paused
   *   entry is always the agent kind.
   * - Idle/done/stopped (or no entry): a no-op, not an error - abort is
   *   safe to call on an agent with nothing running.
   */
  async abort(agentId: string, reason?: string): Promise<void> {
    const entry = this.entries.get(agentId);
    if (!entry) {
      return;
    }
    const abortReason = reason ?? 'user';
    if (entry.status === 'paused') {
      await this.abortPaused(agentId, entry, abortReason);
      return;
    }
    if (entry.status !== 'running') {
      return;
    }
    await this.abortRunning(entry, abortReason);
  }

  /** The running-run half of abort(): agent path through the host, flow path through its controller. */
  private async abortRunning(entry: RunEntry, reason: string): Promise<void> {
    if (entry.kind === 'agent') {
      if (entry.hostRunId !== undefined) await this.opts.host.abort(entry.hostRunId, reason);
      return;
    }
    // DOMException named 'AbortError' keeps the SDK's abort detection (and
    // the reason string readable off signal.reason) working - see
    // abortableProvider.ts's RunAbortedError doc comment.
    entry.controller?.abort(new DOMException(reason, 'AbortError'));
  }

  /**
   * The paused-run half of abort(): the host discards the pending approval
   * (no 'settled' event follows), then the entry is marked 'stopped' with
   * the reason - see abort()'s doc comment for why the order matters.
   */
  private async abortPaused(agentId: string, entry: RunEntry, reason: string): Promise<void> {
    if (entry.kind === 'agent' && entry.hostRunId !== undefined) {
      await this.opts.host.abort(entry.hostRunId, reason);
    }
    this.setEntry(agentId, {
      status: 'stopped',
      reason: undefined,
      pendingApproval: undefined,
      deadlineTimer: this.clearDeadlineTimer(entry),
      controller: undefined,
      hostRunId: undefined,
      abortReason: reason,
    });
  }

  /**
   * `POST /agents/:id/stop` - kept for existing callers (the draft tool's
   * run timeout, older clients); now just `abort(agentId, 'user')`. Still
   * synchronous on purpose: the abort itself proceeds in the background
   * and the 'stopped' status arrives via the usual status push.
   */
  stop(agentId: string): void {
    void this.abort(agentId, 'user');
  }

  /**
   * Resolves a pending approval (the human-in-the-loop round trip) through
   * the AgentHost (`resolveApproval` → `approvals.streamResolve`), then
   * continues broadcasting status/events for the resumed run exactly like
   * run() does - the resumed run's events and settle arrive on the launch's
   * `onEvent`, dispatched by `onHostEvent`.
   */
  async approve(agentId: string, approvalId: string, approved: boolean, note?: string): Promise<void> {
    await this.resolvePaused(agentId, approvalId, (hostRunId) =>
      this.opts.host.resolveApproval(hostRunId, approvalId, { approved, note })
    );
  }

  /**
   * Answers a pending `ask_question` pause through the AgentHost
   * (`answerQuestion` → `approvals.streamAnswer`), then keeps broadcasting
   * status/events for the resumed run exactly like approve() does - the
   * resumed run's events and settle arrive on the launch's `onEvent`.
   */
  async answer(agentId: string, approvalId: string, answer: string): Promise<void> {
    await this.resolvePaused(agentId, approvalId, (hostRunId) =>
      this.opts.host.answerQuestion(hostRunId, approvalId, answer)
    );
  }

  /**
   * The shared body of approve()/answer(): the named pause must be pending
   * on a live agent-path run (stale or unknown ids - including a second
   * decision for an already-resolved pause - are 409s), then `resolve`
   * resumes it through the host and the entry flips back to 'running' with
   * its deadline disarmed.
   */
  private async resolvePaused(
    agentId: string,
    approvalId: string,
    resolve: (hostRunId: string) => Promise<void>
  ): Promise<void> {
    const entry = this.entries.get(agentId);
    if (!entry || entry.status !== 'paused' || entry.pendingApproval?.approvalId !== approvalId) {
      throw new NoActiveRunError(`Agent '${agentId}' has no pending pause '${approvalId}' to resolve`);
    }
    const hostRunId = entry.hostRunId;
    if (entry.kind !== 'agent' || hostRunId === undefined) {
      throw new NoActiveRunError(`Agent '${agentId}' has no live run to resolve pause '${approvalId}' on`);
    }

    try {
      await resolve(hostRunId);
    } catch (error) {
      if (error instanceof HostRunNotActiveError) {
        throw new NoActiveRunError(`Agent '${agentId}' has no pending pause '${approvalId}' to resolve`);
      }
      throw error;
    }
    // The resumed run keeps the launch's hostRunId and debug session (its
    // extraHooks are the launch's own - breakpoints set mid-run still
    // apply, exactly like before).
    this.setEntry(agentId, {
      status: 'running',
      reason: undefined,
      pendingApproval: undefined,
      deadlineTimer: this.clearDeadlineTimer(entry),
    });
  }

  /**
   * The steps of run `runId`'s latest execution (a run id is a
   * checkpoint session id: the agent id, or a fork's id), oldest first, each
   * the newest checkpoint saved at that step - the one fork() forks from.
   * Undefined when the run has no history.
   */
  // fallow-ignore-next-line unused-class-member -- called as `workspaceOf(req).runs.history(...)` in app.ts route handlers
  async history(runId: string): Promise<RunHistoryStep[] | undefined> {
    const entries = (await getCheckpointHistory(this.opts.checkpointStore, runId)) ?? [];
    const rows: CheckpointHistoryEntry[] = [];
    for (const entry of entries) {
      const last = rows.at(-1);
      if (last && entry.step > last.step) break; // an earlier execution of the conversation
      if (last?.step !== entry.step) rows.push(entry);
    }
    return rows.length > 0 ? rows.reverse().map(toHistoryStep) : undefined;
  }

  /**
   * Forks run `runId` at `fromStep` (`AgentExecutor.fork()`, with
   * `patch`) and starts the fork as a run of its own, under the returned id,
   * with the source run's spec - same lifecycle, status and WS stream as any
   * other run (`/agents/<id>/status`, `WS /agents/<id>/stream`).
   */
  // fallow-ignore-next-line unused-class-member -- called as `workspaceOf(req).runs.fork(...)` in app.ts route handlers
  async fork(runId: string, fromStep: number, patch: ForkPatch): Promise<string> {
    const spec = this.entries.get(runId)?.lastSpec ?? (await this.opts.loadSpec(runId));
    if (!spec) throw new AgentNotFoundError(`No agent spec for run '${runId}'`);
    const { checkpointStore } = this.opts;
    const fork = await AgentExecutor.fork({ sessionId: runId, fromStep, checkpointStore, patch });
    // Not via launch()'s `spec` argument, which would save the fork as an agent.
    this.setEntry(fork.sessionId, { lastSpec: spec });
    await this.launch(fork.sessionId, []);
    return fork.sessionId;
  }

  /** `compareTrajectories()` of two runs' latest checkpoints, or undefined when either has none. */
  // fallow-ignore-next-line unused-class-member -- called as `workspaceOf(req).runs.compare(...)` in app.ts route handlers
  async compare(a: string, b: string): Promise<TrajectoryComparison | undefined> {
    const [left, right] = await Promise.all([this.opts.checkpointStore.load(a), this.opts.checkpointStore.load(b)]);
    return left && right ? compareTrajectories(left, right) : undefined;
  }

  /**
   * Replaces the breakpoint set for `agentId`, persisted across runs.
   * If a run is currently in flight, its live DebugSession is updated too
   * so the change takes effect on the very next hook call, not just future
   * run()s.
   */
  setBreakpoints(agentId: string, keys: BreakpointKey[]): void {
    this.breakpoints.set(agentId, new Set(keys));
    this.entries.get(agentId)?.debugSession?.setBreakpoints(keys);
  }

  /** Resumes a run paused at a breakpoint. No-op if not currently paused. */
  continueRun(agentId: string): void {
    this.entries.get(agentId)?.debugSession?.continue();
  }

  /** Resumes a run paused at a breakpoint, or arms a pause at the very next LLM/tool boundary if not currently paused. */
  // fallow-ignore-next-line unused-class-member -- called as `workspaceOf(req).runs.stepRun(...)` in app.ts route handlers
  stepRun(agentId: string): void {
    this.entries.get(agentId)?.debugSession?.step();
  }

  debugState(agentId: string): { agentId: string; paused: boolean; breakpoints: BreakpointKey[] } & Record<string, unknown> {
    const session = this.entries.get(agentId)?.debugSession;
    const breakpoints = [...(this.breakpoints.get(agentId) ?? [])];
    if (!session) {
      return { agentId, paused: false, breakpoints, messages: [], stepCount: 0 };
    }
    return { agentId, ...session.snapshot() };
  }
}
