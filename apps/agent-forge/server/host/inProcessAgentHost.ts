/**
 * InProcessAgentHost: the `AgentHost` that runs specs through Studio's own
 * SDK in this process - `buildRunnableAgent` (../buildAgentV2.ts) compiles
 * the spec with this workspace's stores and Studio's provider keys, and
 * `agent.stream()` / `agent.approvals.streamResolve()` drive it. It exists
 * so `RunManager` speaks only `AgentHost`: `BridgeAgentHost` (the
 * workspace's installed SDK over `lousho bridge`) replaces it per
 * workspace without RunManager changing.
 *
 * One record per `runId` survives across an approval pause: the run's
 * `HostRunInput` (so a resume re-emits on the same `onEvent`), the live
 * `AgentRun` + its `AbortController`, and the approval ids it is paused
 * on. A settled run keeps its record only while `awaiting-approval`;
 * anything else drops it, making later steer/resolve calls
 * `HostRunNotActiveError`s.
 */
import { randomUUID } from 'node:crypto';
import {
  listBuiltinTools,
  listGuardrails,
  listModels,
  listTriggerTypes,
  SDKError,
  VERSION,
  type AgentRun,
  type ExecutionResult,
} from 'lousho';
import { buildRunnableAgent, type RunWiring, type StudioRunDeps } from '../buildAgentV2';
import {
  HostRunNotActiveError,
  type AgentHost,
  type HostCatalog,
  type HostRun,
  type HostRunInput,
  type HostRunResult,
  type HostSteerResult,
} from './agentHost';

interface RunRecord {
  input: HostRunInput;
  live?: { run: AgentRun; controller: AbortController };
  pausedApprovalIds: string[];
}

export class InProcessAgentHost implements AgentHost {
  readonly kind = 'in-process';
  readonly sdkVersion = VERSION;
  private readonly runs = new Map<string, RunRecord>();

  constructor(private readonly deps: StudioRunDeps) {}

  /** The RunWiring every build of this input uses, so a resumed run emits on the same `onEvent`. */
  private wiringFor(input: HostRunInput): RunWiring {
    return {
      onEvent: (event) => input.onEvent({ type: 'agent', event }),
      exporter: {
        onSpanStart: (span) => input.onEvent({ type: 'span', phase: 'start', span }),
        onSpanEnd: (span) => input.onEvent({ type: 'span', phase: 'end', span }),
      },
      ...(input.captureContent !== undefined && { captureContent: input.captureContent }),
      ...(input.extraHooks !== undefined && { extraHooks: input.extraHooks }),
    };
  }

  async start(input: HostRunInput): Promise<HostRun> {
    const built = await buildRunnableAgent(input.spec, input.agentId, this.deps, this.wiringFor(input));
    if (built.flow !== undefined) {
      throw new Error('Flow specs run through RunManager.startFlowRun, not AgentHost.start');
    }
    const runId = randomUUID();
    const controller = new AbortController();
    const run = built.agent.stream(input.input, { sessionId: input.sessionId, signal: controller.signal });
    const record: RunRecord = { input, live: { run, controller }, pausedApprovalIds: [] };
    this.runs.set(runId, record);
    this.watch(runId, record, run);
    return { runId, modelLabel: built.modelLabel };
  }

  async steer(runId: string, message: string): Promise<HostSteerResult> {
    const record = this.runs.get(runId);
    if (record?.live === undefined) {
      throw new HostRunNotActiveError(`Run '${runId}' is not live (it settled or never existed)`);
    }
    const result = record.live.run.steer(message);
    void result.joined.then((joined) => record.input.onEvent({ type: 'steer.joined', steerId: result.id, joined }));
    return { id: result.id, applied: result.applied };
  }

  async abort(runId: string, reason?: string): Promise<void> {
    const record = this.runs.get(runId);
    if (record === undefined) return;
    if (record.live !== undefined) {
      record.live.controller.abort(new DOMException(reason ?? 'user', 'AbortError'));
      return;
    }
    // Paused: discard the pending approval files; no 'settled' event follows a discarded pause.
    for (const id of record.pausedApprovalIds) {
      await this.deps.approvalStore.resolveFor(record.input.agentId, id);
    }
    this.runs.delete(runId);
  }

  async resolveApproval(runId: string, approvalId: string, decision: { approved: boolean; note?: string }): Promise<void> {
    const record = this.pausedOn(runId, approvalId);
    await this.resume(record, (built, signal) =>
      built.agent.approvals.streamResolve({ id: approvalId, approved: decision.approved, note: decision.note }, { signal })
    );
    record.pausedApprovalIds = record.pausedApprovalIds.filter((id) => id !== approvalId);
  }

  async answerQuestion(runId: string, questionId: string, answer: string): Promise<void> {
    const record = this.pausedOn(runId, questionId);
    await this.resume(record, (built, signal) => built.agent.approvals.streamAnswer({ id: questionId, answer }, { signal }));
    record.pausedApprovalIds = record.pausedApprovalIds.filter((id) => id !== questionId);
  }

  async catalog(): Promise<HostCatalog> {
    return {
      tools: listBuiltinTools(),
      models: listModels(),
      guardrails: listGuardrails(),
      triggers: listTriggerTypes(),
    };
  }

  async dispose(): Promise<void> {
    for (const record of this.runs.values()) {
      record.live?.controller.abort(new DOMException('dispose', 'AbortError'));
    }
    this.runs.clear();
  }

  private pausedOn(runId: string, approvalId: string): RunRecord {
    const record = this.runs.get(runId);
    if (record === undefined || record.live !== undefined || !record.pausedApprovalIds.includes(approvalId)) {
      throw new HostRunNotActiveError(`Run '${runId}' is not paused on approval '${approvalId}'`);
    }
    return record;
  }

  /** Rebuilds the run's agent with the same wiring and starts `begin`, tracked as the record's new live run. */
  private async resume(record: RunRecord, begin: (built: Awaited<ReturnType<typeof buildRunnableAgent>>, signal: AbortSignal) => AgentRun): Promise<void> {
    const built = await buildRunnableAgent(record.input.spec, record.input.agentId, this.deps, this.wiringFor(record.input));
    const controller = new AbortController();
    const run = begin(built, controller.signal);
    record.live = { run, controller };
    this.watch(this.runIdOf(record), record, run);
  }

  private runIdOf(record: RunRecord): string {
    for (const [runId, candidate] of this.runs) {
      if (candidate === record) return runId;
    }
    throw new HostRunNotActiveError('Run record no longer tracked');
  }

  /** Reports the run's terminal `settled`/`failed` once `run.result` resolves, and keeps/drops the record. */
  private watch(runId: string, record: RunRecord, run: AgentRun): void {
    run.result
      .then(async (result) => {
        record.live = undefined;
        const pending = await this.pendingOf(record, result);
        if (pending === undefined) {
          this.runs.delete(runId);
        } else {
          record.pausedApprovalIds = result.approvalIds ?? (result.approvalId ? [result.approvalId] : []);
        }
        record.input.onEvent({ type: 'settled', result: this.hostResult(result, pending) });
      })
      .catch((error: unknown) => {
        record.live = undefined;
        this.runs.delete(runId);
        record.input.onEvent({
          type: 'failed',
          error: {
            message: (error as Error)?.message ?? String(error),
            ...(error instanceof SDKError && { code: error.code }),
            name: (error as Error)?.name,
          },
        });
      });
  }

  /** The pending record of an `awaiting-approval` settle, or undefined for any other finish (or a missing file). */
  private async pendingOf(record: RunRecord, result: ExecutionResult) {
    if (result.finishReason !== 'awaiting-approval' || result.approvalId === undefined) return undefined;
    return (await this.deps.approvalStore.peek(record.input.agentId, result.approvalId))?.pending;
  }

  /** Exactly the `HostRunResult` keys - `object`/`pendingApproval` only when the run produced them. */
  private hostResult(result: ExecutionResult, pendingApproval: HostRunResult['pendingApproval']): HostRunResult {
    return {
      finishReason: result.finishReason,
      text: result.text,
      messages: result.messages,
      usage: result.usage,
      steps: result.steps,
      ...(result.approvalId !== undefined && { approvalId: result.approvalId }),
      ...(result.approvalIds !== undefined && { approvalIds: result.approvalIds }),
      ...(result.abortReason !== undefined && { abortReason: result.abortReason }),
      ...(result.object !== undefined && { object: result.object }),
      ...(pendingApproval !== undefined && { pendingApproval }),
    };
  }
}
