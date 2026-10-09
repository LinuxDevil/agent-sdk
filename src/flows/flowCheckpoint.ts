/**
 * Eve DUR-F17: durable flow runs. With a `checkpointStore` and a `runId`,
 * FlowExecutor saves the run's state after every completed node, and
 * `FlowExecutor.resume()` continues it, skipping the nodes that completed.
 *
 * A node is identified by its place in the flow (`0` the root, `0.2` its
 * third child, `0.2.1` ...; a `forEach` iteration's step is `<loop>.<index>`),
 * not by its optional `id`, which need not be unique and is repeated by every
 * loop iteration.
 */

import type { ProviderUsage } from '../providers';
import type { Checkpoint, CheckpointStatus, CheckpointStore, FlowCheckpointState } from '../execution/checkpoint';
import { ConfigurationError, SDKError } from '../execution/errors';

/** The run's usage and completed-step count so far, as FlowExecutor reports them. */
export interface FlowRunProgress {
  usage: ProviderUsage;
  steps: number;
}

/** The sum of two usages (`cachedInputTokens`, `cacheWriteTokens`, `reasoningTokens`, `costUsd` only when either has them). */
export function addUsage(a: ProviderUsage, b: ProviderUsage): ProviderUsage {
  const total: ProviderUsage = {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
  for (const key of ['cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens', 'costUsd'] as const) {
    if (a[key] !== undefined || b[key] !== undefined) {
      total[key] = (a[key] ?? 0) + (b[key] ?? 0);
    }
  }
  return total;
}

const ZERO_USAGE: ProviderUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** The checkpoint store and run id of a durable run; both or neither. */
export function durableOptions(
  options: { checkpointStore?: CheckpointStore; runId?: string },
  method: 'execute' | 'resume'
): { store: CheckpointStore; runId: string } | undefined {
  const { checkpointStore, runId } = options;
  if (checkpointStore && typeof runId === 'string' && runId.length > 0) {
    return { store: checkpointStore, runId };
  }
  if (method === 'execute' && !checkpointStore && runId === undefined) {
    return undefined;
  }
  throw new ConfigurationError(
    `FlowExecutor.${method}: a durable run needs both 'checkpointStore' and a non-empty 'runId'. ` +
      `Example: FlowExecutor.${method}(flow, { ...context, checkpointStore: memoryStore().checkpoints, runId: 'order-42' })`,
    checkpointStore ? 'runId' : 'checkpointStore'
  );
}

/**
 * The state of one durable run: what completed, and the store it is saved to.
 * Saves are chained, so concurrent nodes (a `parallel` step) save in order.
 */
export class FlowRun {
  private readonly completed: Map<string, unknown>;
  private readonly choices: Map<string, number>;
  private readonly priorUsage: ProviderUsage;
  private readonly priorSteps: number;
  private saving: Promise<void> = Promise.resolve();
  /** Set by FlowExecutor once the run has started, to read its usage and steps. */
  progress: () => FlowRunProgress = () => ({ usage: { ...ZERO_USAGE }, steps: 0 });

  constructor(
    private readonly store: CheckpointStore,
    readonly runId: string,
    private readonly code: string,
    private readonly variables: Record<string, unknown>,
    saved?: FlowCheckpointState
  ) {
    this.completed = new Map(Object.entries(saved?.nodeResults ?? {}));
    this.choices = new Map(Object.entries(saved?.choices ?? {}));
    this.priorUsage = saved?.usage ?? { ...ZERO_USAGE };
    this.priorSteps = saved?.steps ?? 0;
  }

  /** Whether the node at `path` completed (in this run or before the resume). */
  isCompleted(path: string): boolean {
    return this.completed.has(path);
  }

  /** The result the node at `path` completed with. */
  resultOf(path: string): unknown {
    return this.completed.get(path);
  }

  /** The option a `oneOf` node picked before, if it did. */
  choiceOf(path: string): number | undefined {
    return this.choices.get(path);
  }

  /** Remember a `oneOf` node's pick (saved with the next checkpoint). */
  setChoice(path: string, index: number): void {
    this.choices.set(path, index);
  }

  /** Record a completed node, drop its children's entries, and save. */
  async complete(path: string, result: unknown): Promise<void> {
    const prefix = `${path}.`;
    for (const map of [this.completed, this.choices]) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) map.delete(key);
      }
    }
    this.completed.set(path, result);
    await this.save('in-progress');
  }

  /** The run's usage and steps including those before a resume. */
  totals(): FlowRunProgress {
    const now = this.progress();
    return { usage: addUsage(this.priorUsage, now.usage), steps: this.priorSteps + now.steps };
  }

  /** Save the run's state now (after any save in flight). */
  save(status: CheckpointStatus, extra: Partial<Pick<FlowCheckpointState, 'output'>> = {}): Promise<void> {
    const checkpoint = this.snapshot(status, extra);
    const next = this.saving.then(() => this.store.save(this.runId, checkpoint));
    // A failed save fails the node that made it; later saves still run.
    this.saving = next.catch(() => undefined);
    return next;
  }

  private snapshot(status: CheckpointStatus, extra: Partial<Pick<FlowCheckpointState, 'output'>>): Checkpoint {
    const { usage, steps } = this.totals();
    // A copy, so a store that keeps the object is not changed by later steps.
    const flow: FlowCheckpointState = structuredClone({
      code: this.code,
      variables: this.variables,
      completedNodeIds: [...this.completed.keys()],
      nodeResults: Object.fromEntries(this.completed),
      choices: Object.fromEntries(this.choices),
      usage,
      steps,
      ...extra,
    });
    return {
      agentId: `flow:${this.code}`,
      sessionId: this.runId,
      stepIndex: steps,
      messages: [],
      toolCalls: [],
      usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens },
      status,
      flow,
    };
  }
}

/** The flow state of a run's checkpoint, checked against the flow resuming it. */
export function flowStateOf(checkpoint: Checkpoint | null, runId: string, code: string): FlowCheckpointState {
  if (!checkpoint) {
    throw new SDKError(
      `FlowExecutor.resume: no checkpoint for run '${runId}'. Start the run with FlowExecutor.execute(flow, { ...context, checkpointStore, runId }).`,
      'LOUSHO_CHECKPOINT_NOT_FOUND',
      { appendHelp: false }
    );
  }
  if (!checkpoint.flow) {
    throw new ConfigurationError(`FlowExecutor.resume: run '${runId}' is not a flow run (its checkpoint has no flow state).`, 'runId');
  }
  if (checkpoint.flow.code !== code) {
    throw new ConfigurationError(
      `FlowExecutor.resume: run '${runId}' belongs to flow '${checkpoint.flow.code}', not '${code}'. Resume it with the flow that started it.`,
      'runId'
    );
  }
  return checkpoint.flow;
}
