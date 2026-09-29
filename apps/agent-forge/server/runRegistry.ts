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
import {
  AgentExecutor,
  ToolRegistry,
  type ExecutionEvent,
  type CheckpointStore,
  resumeAfterApproval,
  type AgentSpec,
} from '@loushy/build-ai-agent';
import { buildAgentFromSpec } from './buildAgent';
import { withAbortSignal, RunAbortedError } from './abortableProvider';
import { FileApprovalStore } from './approvalStore';
import type { AgentRunStatusPayload, RunStatus } from './types';

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

export class RunManager extends EventEmitter {
  private readonly entries = new Map<string, RunEntry>();

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
    })
      .then((result) => this.handleRunSettled(agentId, result))
      .catch((error: unknown) => this.handleRunFailed(agentId, error));

    void entry; // status already broadcast by setEntry() above
  }

  /** Shared success-path handling for both run() and approve()'s follow-up execute() call. */
  private async handleRunSettled(
    agentId: string,
    result: { finishReason: string; approvalId?: string; text: string }
  ): Promise<void> {
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
      });
      return;
    }
    this.setEntry(agentId, { status: 'stopped', resultText: result.text, controller: undefined });
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
    this.setEntry(agentId, {
      status: 'running',
      reason: undefined,
      pendingApproval: undefined,
      controller,
    });

    resumeAfterApproval(
      { id: approvalId, approved, note },
      this.opts.approvalStore,
      toolRegistry ?? new ToolRegistry(),
      withAbortSignal(provider, controller.signal),
      { onEvent: (event) => this.emitEvent(agentId, event) },
      this.opts.checkpointStore
    )
      .then((result) => this.handleRunSettled(agentId, result))
      .catch((error: unknown) => this.handleRunFailed(agentId, error));
  }
}
