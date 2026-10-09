/**
 * In-memory registry mapping agent IDs to live `AgentExecutor.execute()`
 * invocations, tracked by `sessionId` (N1). One `RunEntry` per agent ID -
 * only one live run per agent at a time, matching the app's Run/Stop/Debug
 * buttons which operate on "the currently loaded agent".
 *
 * This is the piece that actually wires N2 (start/stop/status) and N3
 * (durable-execution resume + approval-gate pause/resume) together on top
 * of the SDK's public execution API.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileTraceExporter } from '@lousho/build-ai-agent/traces';
import { agentTraceDir, fanOutExporter } from './traceStore';
import { AgentExecutor, ToolRegistry, resumeAfterApproval } from '@lousho/build-ai-agent/executor';
import {
  type AgentEvent,
  type CheckpointStore,
  type Span,
  type TraceExporter,
  type ExecutionResult,
  type Message,
  emptyRunUsage,
  compareTrajectories,
  getCheckpointHistory,
  type AgentSpec,
  type CheckpointHistoryEntry,
  type ForkPatch,
  type TrajectoryComparison,
} from '@lousho/build-ai-agent';
import { FlowExecutor, type AgentFlow } from '@lousho/build-ai-agent/flows';
import { buildAgentFromSpec, extractFlowFromSpec } from './buildAgent';
import { withAbortSignal, RunAbortedError } from './abortableProvider';
import { FileApprovalStore } from './approvalStore';
import { DebugSession, type BreakpointKey } from './debugController';
import { FileChatStore, previewFor } from './chatStore';
import { markRunInput, reconcileChatMessages } from './chatReconcile';
import { toLogEntries, toFlowLogEntries } from './logEntries';
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
  ChatSessionMeta,
  ChatSessionRecord,
  RunHistoryStep,
} from '../shared/wireTypes';

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
  resultText?: string;
  /** O4: full ExecutionResult (messages/toolCalls/usage/steps/finishReason) for the Output tab's JSON tree. */
  result?: ExecutionResult;
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
  lastSpec?: AgentSpec;
  /** Eve DUI-F4: `<provider>/<model>` the last run actually used, for the Topbar's env pill. */
  provider?: string;
  /** O3: live step-through debug session for this agent's in-flight run, if any. */
  debugSession?: DebugSession;
  /**
   * Eve DUI-F21: the `input` of the latest `run()` (the top bar's Run), so
   * the user turn it adds is tagged `source: 'run'` in the transcript
   * instead of passing for something the user typed in Chat.
   */
  runInput?: string;
  /**
   * P1/P3: the chat transcript for this agent's CURRENT chat session -
   * reconciled from the real `ExecutionResult.messages` on every run
   * settle (see chatReconcile.ts), plus the just-sent user message pushed
   * optimistically by sendMessage() before the run even starts. Persisted
   * to disk (chatStore) on every change so it survives a server restart.
   */
  messages: ChatMessage[];
  /** P3: id of the chat session `messages` belongs to - stable across Stop/Run continuations, changes only on newChat(). */
  chatSessionId: string;
  /** P3: when the current chat session started, for its ChatSessionMeta. */
  chatStartedAt: string;
}

export interface RunManagerOptions {
  baseDir: string;
  checkpointStore: CheckpointStore;
  /** Must be a FileApprovalStore (agent-scoped resolveFor) - see approve(). */
  approvalStore: FileApprovalStore;
  /**
   * Fallback spec loader used when run() is called without an explicit
   * `spec` (e.g. a restarted server resuming via /status polling) - backed
   * by the app's AgentStore, fsAgentStore, reading `.lousho/agents/<id>.yaml`.
   */
  loadSpec: (agentId: string) => Promise<AgentSpec | undefined>;
  /** Persists a run's spec to disk (fsAgentStore.save) so it survives a server restart. */
  saveSpec?: (agentId: string, spec: AgentSpec) => Promise<void>;
  /** P1/P3: chat transcript persistence. Defaults to `new FileChatStore(baseDir)` when omitted. */
  chatStore?: FileChatStore;
  /** R1: stored provider keys - see buildAgent.ts's resolveProviderForSpec(). Omitted (e.g. in older tests) means every real provider type falls back to mock, same as no keys configured. */
  secretsStore?: SecretsStore;
  /** R3: active settings profile source (hook timeout today; provider/deploy-adapter selection lives on the profile too, for the Settings UI). */
  settingsStore?: SettingsStore;
}

export class AgentNotFoundError extends Error {}
export class AlreadyRunningError extends Error {}
export class NoActiveRunError extends Error {}
/** P1: a chat message was sent while the run was paused awaiting a tool approval decision - resolve that first via approve(). */
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
function authoritativeMessages(result: ExecutionResult): Message[] {
  const last = result.messages[result.messages.length - 1];
  const alreadyEndsWithText = last?.role === 'assistant' && last.content === result.text;
  return result.text && !alreadyEndsWithText
    ? [...result.messages, { role: 'assistant', content: result.text }]
    : result.messages;
}

/** P1: strips the id/timestamp this file adds for the UI, back to the SDK's real `Message` shape for feeding into AgentExecutor.execute(). */
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

/** LOU-D45: a history entry as the History panel lists it. */
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
   * O3: breakpoints persist per agent id across runs (set them once, they
   * apply to every future run() until cleared/changed), independent of the
   * in-flight `RunEntry.debugSession` - a fresh DebugSession is created
   * per-run() but seeded from this map.
   */
  private readonly breakpoints = new Map<string, Set<BreakpointKey>>();
  /** P1/P3: chat transcript persistence (see chatStore.ts). */
  private readonly chatStore: FileChatStore;

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
      updatedAt: entry.updatedAt,
    };
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
    // P3: a brand-new (never-touched-this-process) agent id picks up any
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
    // LOU-Q: a small "current session pointer" file would close this gap.
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

  /** P1: current live chat transcript for `agentId` (creates no run - safe to call for an agent that has never run). */
  chatState(agentId: string): ChatStatePayload {
    const entry = this.entries.get(agentId) ?? this.freshEntry(agentId);
    return { agentId, sessionId: entry.chatSessionId, messages: entry.messages };
  }

  /** P3: metadata for every persisted chat session for `agentId` (including the current one, once it has been saved at least once). */
  listChats(agentId: string): ChatSessionMeta[] {
    return this.chatStore.list(agentId);
  }

  /** P3: a full past (or current) chat session's transcript, or undefined if unknown. */
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
   * P3: archives the current chat session (already persisted incrementally
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

  private emitSpan(agentId: string, span: Span): void {
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
  }

  /**
   * O2: builds a `TraceExporter` (src/execution/tracing.ts) that forwards
   * every real span start/end notification for this run over the existing
   * WS channel (as `{type:'span', ...}` messages, see wsServer.ts) rather
   * than a second tracing pipeline. M5b: it also writes the run to the
   * agent's trace folder (see traceStore.ts), so the Trace tab can reopen it.
   */
  private makeTraceExporter(agentId: string): TraceExporter {
    const live: TraceExporter = {
      onSpanStart: (span) => this.emitSpan(agentId, span),
      onSpanEnd: (span) => this.emitSpan(agentId, span),
    };
    return fanOutExporter(live, fileTraceExporter({ dir: agentTraceDir(this.opts.baseDir, agentId) }));
  }

  /** O3: (re)creates the debug session for a fresh run(), seeded from this agent's persisted breakpoints. */
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
        // O3 safety net: nobody called continue()/step() before
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
   * what makes Stop-then-Run resume from the last checkpoint (N3) instead
   * of starting over: AgentExecutor.execute() (see its doc comments)
   * rehydrates from `checkpointStore.load(sessionId)` when a checkpoint
   * exists under that id, and only marks it 'finished' on a *successful*
   * terminal completion - never when the run was aborted (see
   * abortableProvider.ts). So after a stop(), the unfinished checkpoint is
   * still there, and the very next run() call for this agentId picks it
   * back up automatically.
   *
   * LOU-U8: `input` is appended to the rehydrated conversation as a new
   * user turn (after the interrupted turn's pending tool results), unless
   * it re-sends the message the interrupted run started from; after a
   * finished run it continues the conversation.
   */
  async run(agentId: string, input: string, spec?: AgentSpec): Promise<void> {
    const existing = this.entries.get(agentId);
    if (existing && existing.status === 'running') {
      throw new AlreadyRunningError(`Agent '${agentId}' is already running`);
    }
    await this.launch(agentId, input, spec, { runInput: input });
  }

  /**
   * P1: `POST /agents/:id/message` - appends a chat message to the agent's
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
   *   the new message CONTINUES that exact conversation - the real
   *   `Message[]` AgentExecutor last produced (stripped of the id/timestamp
   *   fields this file adds for the UI) plus the new user turn, passed as
   *   `input` with `skipSystemPromptInjection: true` so AgentExecutor
   *   doesn't inject a second system message ahead of the one already in
   *   that history. A genuinely new agent (no prior chat) passes the plain
   *   string instead, so AgentExecutor's normal buildMessages() path builds
   *   the system+user turn from scratch exactly like a Topbar "Run" click.
   *
   * The checkpoint under this agent's sessionId already holds that same
   * history; AgentExecutor.execute() (LOU-U8) recognises the re-sent prefix
   * and appends only the new user turn - after a Stop mid-flight, once the
   * interrupted turn's pending tool results are recorded.
   */
  async sendMessage(agentId: string, text: string, spec?: AgentSpec): Promise<void> {
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

    const input: string | Message[] =
      priorMessages.length > 0 ? [...priorMessages.map(toSdkMessage), toSdkMessage(userMessage)] : text;

    try {
      await this.launch(agentId, input, spec, { skipSystemPromptInjection: priorMessages.length > 0 });
    } catch (error) {
      // The run never started (no spec, provider not configured - Eve
      // DUI-F4): take the user's message back out of the transcript so a
      // retry after fixing it doesn't send it twice.
      const current = this.entries.get(agentId);
      if (current) this.emitChat(agentId, this.setEntry(agentId, { messages: priorMessages }, current));
      throw error;
    }
  }

  /** Picks the spec to run: the supplied one (persisted if a saveSpec hook exists), else the last-run one, else the saved one. */
  private async resolveLaunchSpec(
    agentId: string,
    spec: AgentSpec | undefined,
    existing: RunEntry | undefined
  ): Promise<AgentSpec> {
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
   * Shared run-kickoff for both run() and sendMessage() - builds the
   * agent/provider/toolRegistry, flips status to 'running', and fires off
   * the AgentExecutor.execute() call, wiring its settle/failure back into
   * this registry's status/chat broadcasts exactly like the original run()
   * did (see that method's doc comment above, still accurate for the
   * sessionId=agentId / checkpoint-resume semantics this shares).
   */
  private async launch(
    agentId: string,
    input: string | Message[],
    spec?: AgentSpec,
    options: { skipSystemPromptInjection?: boolean; runInput?: string } = {}
  ): Promise<void> {
    const existing = this.entries.get(agentId);
    const resolvedSpec = await this.resolveLaunchSpec(agentId, spec, existing);

    // Build the agent/provider/toolRegistry BEFORE flipping status to
    // 'running' - resolveSpecProvider()/resolveSpecTool() (inside
    // buildAgentFromSpec) throw synchronously for a bad provider type or
    // unknown tool name, and if that happened after setEntry('running') the
    // entry would be stuck reporting 'running' forever (the .catch() chain
    // that would otherwise flip it to 'error' is never reached, since the
    // throw happens before AgentExecutor.execute() is even called).
    const { agent, provider, toolRegistry, hooks, sandbox } = buildAgentFromSpec(
      resolvedSpec,
      agentId,
      undefined,
      { secretsStore: this.opts.secretsStore, hookTimeoutMs: this.opts.settingsStore?.activeProfile().hookTimeoutMs }
    );

    const sessionId = agentId;
    const controller = new AbortController();
    const debugSession = this.makeDebugSession(agentId);

    const entry = this.setEntry(
      agentId,
      {
        status: 'running',
        sessionId,
        controller,
        error: undefined,
        reason: undefined,
        pendingApproval: undefined,
        resultText: undefined,
        runInput: options.runInput,
        lastSpec: resolvedSpec,
        provider: `${provider.name}/${resolvedSpec.provider.model}`,
        debugSession,
      },
      existing
    );

    const abortableProvider = withAbortSignal(provider, controller.signal);

    // LOU-T3: a graph containing a `router` node compiles (graphToSpec.ts)
    // to a real branching `AgentFlow` stashed under `spec.policy.flow`
    // rather than being runnable through the flat AgentSpec/AgentExecutor
    // path at all (there's no router/branch concept in `AgentConfig`). Every
    // OTHER agent - which is every existing template/example, and every
    // agent this app could build before this ticket - has no such field and
    // takes the exact same `AgentExecutor.execute()` path it always has,
    // completely unchanged below.
    const flow = extractFlowFromSpec(resolvedSpec);
    if (flow) {
      this.runFlow(agentId, flow, { agent, provider: abortableProvider, toolRegistry, sandbox });
      void entry;
      return;
    }

    AgentExecutor.execute({
      agent,
      input,
      provider: abortableProvider,
      toolRegistry,
      sessionId,
      checkpointStore: this.opts.checkpointStore,
      approvalStore: this.opts.approvalStore,
      onAgentEvent: (event) => this.emitEvent(agentId, event),
      exporter: this.makeTraceExporter(agentId),
      skipSystemPromptInjection: options.skipSystemPromptInjection,
      // LOU-Q1/Q2: hooks compiled from this agent's graph (spec.policy.hooks)
      // and the SandboxAdapter they (and any requiresSandbox tool) run
      // through - see buildAgentFromSpec()/compileHooks.ts.
      hooks,
      sandbox,
      ...debugSession.hooks(),
    })
      .then((result) => this.handleRunSettled(agentId, result))
      .catch((error: unknown) => this.handleRunFailed(agentId, error));

    void entry; // status already broadcast by setEntry() above
  }

  /**
   * LOU-T3: runs a branching graph's compiled `AgentFlow` through
   * `FlowExecutor.execute()` instead of `AgentExecutor.execute()`.
   *
   * Known, DELIBERATE gaps vs. the flat-spec path (see this ticket's
   * report for the full writeup - not silently papered over):
   *  - No checkpointStore/approvalStore: `FlowExecutor` has no
   *    pause/resume or human-in-the-loop-approval primitive at all, so a
   *    branching run cannot pause for approval and Stop-then-Run cannot
   *    resume it from a mid-flight checkpoint the way a flat-spec run can -
   *    it always runs to completion or failure in one call.
   *  - No abort support: `FlowExecutor.execute()` takes no
   *    AbortSignal/controller, so `stop()`'s `controller.abort()` cannot
   *    actually interrupt an in-flight flow step the way
   *    `abortableProvider.ts` does for the flat-spec path; the Stop button
   *    only prevents a NOT-yet-started flow from starting.
   *  - No hooks/sandbox-gated tool calls beyond `requiresSandbox` itself:
   *    `FlowExecutor.executeToolCall()` does route through the same
   *    `executeToolWithSandboxGuard()` seam, but there is no `hooks`
   *    parameter at all, so LOU-Q pre/post hooks attached to a node never
   *    fire on a branching run.
   *  - Debug console: logs only, not trace spans or step-debugger
   *    breakpoints - see `toFlowLogEntries()`'s doc comment in logEntries.ts.
   */
  private runFlow(
    agentId: string,
    flow: AgentFlow,
    deps: {
      agent: import('@lousho/build-ai-agent').AgentConfig;
      provider: import('@lousho/build-ai-agent').LLMProvider;
      toolRegistry?: ToolRegistry;
      sandbox: import('@lousho/build-ai-agent').SandboxAdapter;
    }
  ): void {
    FlowExecutor.execute(
      flow,
      { agent: deps.agent, provider: deps.provider, toolRegistry: deps.toolRegistry, variables: {}, sandbox: deps.sandbox },
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

  /** Shared success-path handling for both run() and approve()'s follow-up execute() call. */
  private async handleRunSettled(agentId: string, result: ExecutionResult): Promise<void> {
    // P1: reconcile the chat transcript against the real, authoritative
    // ExecutionResult.messages - see chatReconcile.ts's doc comment for why
    // this (rather than building the transcript incrementally from
    // AgentEvents) is the single source of truth. Done for BOTH the
    // completed and paused-for-approval branches below, since both hand
    // back a full `messages` array (the pause happens exactly at the point
    // the assistant's tool-call message was added).
    const settledAt = new Date().toISOString();
    const entryBefore = this.entries.get(agentId);
    const reconciledMessages = markRunInput(
      reconcileChatMessages(entryBefore?.messages ?? [], authoritativeMessages(result), settledAt),
      entryBefore?.messages ?? [],
      entryBefore?.runInput
    );

    // O4: the full ExecutionResult (messages/toolCalls/usage/steps, not
    // just the final text) is kept on the entry either way, so the
    // client's Output tab can render it as a JSON tree whether the run
    // finished or is paused for approval - "the final OR paused
    // ExecutionResult" per the epic brief.
    if (result.finishReason === 'awaiting-approval' && result.approvalId) {
      const record = await this.opts.approvalStore.peek(agentId, result.approvalId);
      const next = this.setEntry(agentId, {
        status: 'paused',
        reason: 'awaiting_approval',
        pendingApproval: {
          approvalId: result.approvalId,
          toolName: record?.pending.toolName ?? 'unknown',
          args: record?.pending.args ?? {},
          createdAt: record?.pending.createdAt ?? new Date().toISOString(),
        },
        result,
        messages: reconciledMessages,
      });
      this.emitChat(agentId, next);
      return;
    }
    const next = this.setEntry(agentId, {
      status: 'done',
      resultText: result.text,
      result,
      controller: undefined,
      messages: reconciledMessages,
    });
    this.emitChat(agentId, next);
  }

  /** Shared failure-path handling for both run() and approve()'s follow-up execute() call. */
  private handleRunFailed(agentId: string, error: unknown): void {
    if (error instanceof RunAbortedError) {
      // User-initiated stop() - a deliberate terminal state, not an error.
      this.setEntry(agentId, { status: 'stopped', controller: undefined });
      return;
    }
    this.setEntry(agentId, {
      status: 'error',
      error: (error as Error)?.message ?? String(error),
      controller: undefined,
    });
  }

  /**
   * Requests cancellation of the in-flight run for `agentId` (see
   * abortableProvider.ts for exactly what this can and can't interrupt).
   * No-ops (rather than throwing) if the agent isn't currently running -
   * Stop is safe to click on an already-stopped/idle agent.
   */
  stop(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (!entry || entry.status !== 'running' || !entry.controller) {
      return;
    }
    entry.controller.abort();
  }

  /**
   * Resolves a pending approval (N3's human-in-the-loop round trip) via the
   * SDK's public `resumeAfterApproval()`, then continues broadcasting
   * status/events for the resumed run exactly like run() does.
   */
  async approve(agentId: string, approvalId: string, approved: boolean, note?: string): Promise<void> {
    const entry = this.entries.get(agentId);
    if (!entry || entry.status !== 'paused' || entry.pendingApproval?.approvalId !== approvalId) {
      throw new NoActiveRunError(
        `Agent '${agentId}' has no pending approval '${approvalId}' to resolve`
      );
    }

    const spec = entry.lastSpec ?? (await this.opts.loadSpec(agentId));
    if (!spec) throw new AgentNotFoundError(`No saved agent spec for id '${agentId}'`);
    const { provider, toolRegistry, hooks, sandbox } = buildAgentFromSpec(spec, agentId, undefined, {
      secretsStore: this.opts.secretsStore,
      hookTimeoutMs: this.opts.settingsStore?.activeProfile().hookTimeoutMs,
    });

    const controller = new AbortController();
    const debugSession = this.makeDebugSession(agentId);
    this.setEntry(agentId, {
      status: 'running',
      reason: undefined,
      pendingApproval: undefined,
      controller,
      debugSession,
    });

    resumeAfterApproval(
      { id: approvalId, approved, note },
      this.opts.approvalStore,
      toolRegistry ?? new ToolRegistry(),
      withAbortSignal(provider, controller.signal),
      {
        onAgentEvent: (event) => this.emitEvent(agentId, event),
        exporter: this.makeTraceExporter(agentId),
        // LOU-Q1: hooks must fire on the deferred, post-approval tool
        // execution path too (see resume.ts in the core SDK) - not just
        // the initial run() - so the same compiled hooks/sandbox are
        // threaded through here.
        hooks,
        sandbox,
        ...debugSession.hooks(),
      },
      this.opts.checkpointStore
    )
      .then((result) => this.handleRunSettled(agentId, result))
      .catch((error: unknown) => this.handleRunFailed(agentId, error));
  }

  /**
   * LOU-D45: the steps of run `runId`'s latest execution (a run id is a
   * checkpoint session id: the agent id, or a fork's id), oldest first, each
   * the newest checkpoint saved at that step - the one fork() forks from.
   * Undefined when the run has no history.
   */
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
   * LOU-D45: forks run `runId` at `fromStep` (`AgentExecutor.fork()`, with
   * `patch`) and starts the fork as a run of its own, under the returned id,
   * with the source run's spec - same lifecycle, status and WS stream as any
   * other run (`/agents/<id>/status`, `WS /agents/<id>/stream`).
   */
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

  /** LOU-D45: `compareTrajectories()` of two runs' latest checkpoints, or undefined when either has none. */
  async compare(a: string, b: string): Promise<TrajectoryComparison | undefined> {
    const [left, right] = await Promise.all([this.opts.checkpointStore.load(a), this.opts.checkpointStore.load(b)]);
    return left && right ? compareTrajectories(left, right) : undefined;
  }

  /**
   * O3: replaces the breakpoint set for `agentId`, persisted across runs.
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
