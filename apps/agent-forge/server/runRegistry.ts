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
import {
  AgentExecutor,
  ToolRegistry,
  type ExecutionEvent,
  type CheckpointStore,
  type Span,
  type TraceExporter,
  type ExecutionResult,
  resumeAfterApproval,
  type AgentSpec,
} from '@loushy/build-ai-agent';
import { buildAgentFromSpec } from './buildAgent';
import { withAbortSignal, RunAbortedError } from './abortableProvider';
import { FileApprovalStore } from './approvalStore';
import { DebugSession, type BreakpointKey } from './debugController';
import type { AgentRunStatusPayload, RunStatus, LogEntry, LogLevel, LogPhase } from './types';

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
  /** O3: live step-through debug session for this agent's in-flight run, if any. */
  debugSession?: DebugSession;
}

export interface RunManagerOptions {
  baseDir: string;
  checkpointStore: CheckpointStore;
  /** Must be a FileApprovalStore (agent-scoped resolveFor) - see approve(). */
  approvalStore: FileApprovalStore;
  /**
   * Fallback spec loader used when run() is called without an explicit
   * `spec` (e.g. a restarted server resuming via /status polling) - backed
   * by the app's AgentStore, fsAgentStore, reading `.loushy/agents/<id>.yaml`.
   */
  loadSpec: (agentId: string) => Promise<AgentSpec | undefined>;
  /** Persists a run's spec to disk (fsAgentStore.save) so it survives a server restart. */
  saveSpec?: (agentId: string, spec: AgentSpec) => Promise<void>;
}

export class AgentNotFoundError extends Error {}
export class AlreadyRunningError extends Error {}
export class NoActiveRunError extends Error {}

/**
 * O1: translates one `ExecutionEvent` (the SDK's own execution-phase
 * taxonomy - start/text-delta/text-complete/tool-call/tool-result/finish/
 * error, see AgentExecutor.ts) into zero or more structured `LogEntry`
 * rows. This reuses that taxonomy rather than inventing a second, parallel
 * logging vocabulary - `LogPhase` is a coarser regrouping of the same
 * events (e.g. both 'start' and 'finish' map to phase 'trigger', since
 * those are this pipeline's entry/exit points) plus 'sandbox'/'checkpoint'/
 * 'approval'/'debug' phases used by emitters elsewhere in this file for
 * things ExecutionEvent has no dedicated type for.
 */
function toLogEntries(agentId: string, event: ExecutionEvent): LogEntry[] {
  const timestamp = (event.timestamp instanceof Date ? event.timestamp : new Date()).toISOString();
  const base = { id: randomUUID(), agentId, timestamp };

  switch (event.type) {
    case 'start':
      return [{ ...base, level: 'info', phase: 'trigger', message: `Run started for agent '${event.agentName ?? agentId}'` }];
    case 'text-complete':
      return [{ ...base, level: 'info', phase: 'llm', message: event.text ? `LLM response: ${truncate(event.text)}` : 'LLM response received' }];
    case 'tool-call':
      return [
        {
          ...base,
          level: 'tool',
          phase: 'tool',
          toolName: event.toolCall?.function?.name,
          message: `Tool call: ${event.toolCall?.function?.name ?? 'unknown'}`,
          detail: event.toolCall,
        },
      ];
    case 'tool-result': {
      const isError = !!event.toolResult?.error;
      return [
        {
          ...base,
          level: isError ? 'error' : 'tool',
          phase: 'tool',
          toolName: event.toolResult?.toolName,
          message: isError
            ? `Tool '${event.toolResult?.toolName}' failed: ${event.toolResult?.error}`
            : `Tool '${event.toolResult?.toolName}' result: ${truncate(JSON.stringify(event.toolResult?.result))}`,
          detail: event.toolResult,
        },
      ];
    }
    case 'finish':
      return [
        {
          ...base,
          level: 'info',
          phase: event.finishReason === 'awaiting-approval' ? 'approval' : 'trigger',
          message: `Run finished (${event.finishReason})`,
        },
      ];
    case 'error':
      return [{ ...base, level: 'error', phase: 'trigger', message: event.error?.message ?? 'Run failed' }];
    default:
      return [];
  }
}

function truncate(text: string | undefined, max = 400): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
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

  constructor(private readonly opts: RunManagerOptions) {
    super();
    this.setMaxListeners(0);
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
      updatedAt: entry.updatedAt,
    };
  }

  private setEntry(agentId: string, patch: Partial<RunEntry>, base?: RunEntry): RunEntry {
    const prev = base ?? this.entries.get(agentId) ?? {
      status: 'idle' as RunStatus,
      sessionId: agentId,
      updatedAt: new Date().toISOString(),
    };
    const next: RunEntry = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    this.entries.set(agentId, next);
    this.emit('status', this.status(agentId));
    return next;
  }

  private emitEvent(agentId: string, event: ExecutionEvent): void {
    this.emit('event', agentId, {
      type: event.type,
      timestamp: event.timestamp,
      text: event.text,
      toolCall: event.toolCall,
      toolResult: event.toolResult,
      finishReason: event.finishReason,
      error: event.error ? { message: event.error.message } : undefined,
    });
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
    });
  }

  /**
   * O2: builds a `TraceExporter` (src/execution/tracing.ts) that forwards
   * every real span start/end notification for this run over the existing
   * WS channel (as `{type:'span', ...}` messages, see wsServer.ts) rather
   * than a second tracing pipeline.
   */
  private makeTraceExporter(agentId: string): TraceExporter {
    return {
      onSpanStart: (span) => this.emitSpan(agentId, span),
      onSpanEnd: (span) => this.emitSpan(agentId, span),
    };
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
   * exists under that id, and only clears it on a *successful* terminal
   * completion - never when the run was aborted (see abortableProvider.ts).
   * So after a stop(), the checkpoint from the last completed tool result
   * is still there, and the very next run() call for this agentId picks it
   * back up automatically.
   *
   * One consequence worth calling out: when a checkpoint exists,
   * AgentExecutor.execute() ignores `input` entirely and continues the
   * rehydrated conversation - this mirrors resumeAfterApproval()'s
   * documented behavior for the approval-gate case and is intentional: a
   * resumed run is a continuation of the same paused conversation, not a
   * new question. `input` is only actually used to seed a genuinely fresh
   * run (no prior checkpoint).
   */
  async run(agentId: string, input: string, spec?: AgentSpec): Promise<void> {
    const existing = this.entries.get(agentId);
    if (existing && existing.status === 'running') {
      throw new AlreadyRunningError(`Agent '${agentId}' is already running`);
    }

    const resolvedSpec = spec ?? existing?.lastSpec ?? (await this.opts.loadSpec(agentId));
    if (!resolvedSpec) {
      throw new AgentNotFoundError(`No agent spec for id '${agentId}' (none supplied and none saved)`);
    }
    if (spec && this.opts.saveSpec) {
      await this.opts.saveSpec(agentId, spec);
    }

    // Build the agent/provider/toolRegistry BEFORE flipping status to
    // 'running' - resolveSpecProvider()/resolveSpecTool() (inside
    // buildAgentFromSpec) throw synchronously for a bad provider type or
    // unknown tool name, and if that happened after setEntry('running') the
    // entry would be stuck reporting 'running' forever (the .catch() chain
    // that would otherwise flip it to 'error' is never reached, since the
    // throw happens before AgentExecutor.execute() is even called).
    const { agent, provider, toolRegistry } = buildAgentFromSpec(resolvedSpec, agentId);

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
        lastSpec: resolvedSpec,
        debugSession,
      },
      existing
    );

    const abortableProvider = withAbortSignal(provider, controller.signal);

    AgentExecutor.execute({
      agent,
      input,
      provider: abortableProvider,
      toolRegistry,
      sessionId,
      checkpointStore: this.opts.checkpointStore,
      approvalStore: this.opts.approvalStore,
      onEvent: (event) => this.emitEvent(agentId, event),
      exporter: this.makeTraceExporter(agentId),
      ...debugSession.hooks(),
    })
      .then((result) => this.handleRunSettled(agentId, result))
      .catch((error: unknown) => this.handleRunFailed(agentId, error));

    void entry; // status already broadcast by setEntry() above
  }

  /** Shared success-path handling for both run() and approve()'s follow-up execute() call. */
  private async handleRunSettled(agentId: string, result: ExecutionResult): Promise<void> {
    // O4: the full ExecutionResult (messages/toolCalls/usage/steps, not
    // just the final text) is kept on the entry either way, so the
    // client's Output tab can render it as a JSON tree whether the run
    // finished or is paused for approval - "the final OR paused
    // ExecutionResult" per the epic brief.
    if (result.finishReason === 'awaiting-approval' && result.approvalId) {
      const record = await this.opts.approvalStore.peek(agentId, result.approvalId);
      this.setEntry(agentId, {
        status: 'paused',
        reason: 'awaiting_approval',
        pendingApproval: {
          approvalId: result.approvalId,
          toolName: record?.pending.toolName ?? 'unknown',
          args: record?.pending.args ?? {},
          createdAt: record?.pending.createdAt ?? new Date().toISOString(),
        },
        result,
      });
      return;
    }
    this.setEntry(agentId, { status: 'stopped', resultText: result.text, result, controller: undefined });
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
    const { provider, toolRegistry } = buildAgentFromSpec(spec, agentId);

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
        onEvent: (event) => this.emitEvent(agentId, event),
        exporter: this.makeTraceExporter(agentId),
        ...debugSession.hooks(),
      },
      this.opts.checkpointStore
    )
      .then((result) => this.handleRunSettled(agentId, result))
      .catch((error: unknown) => this.handleRunFailed(agentId, error));
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
