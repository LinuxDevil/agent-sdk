/**
 * Background sub-agents (LOU-Y4): `task` with `background: true` starts the
 * child and returns at once; `agent_status`, `agent_await` and `agent_cancel`
 * observe and steer it. One {@link BackgroundTasks} exists per lead run.
 */

import { SubagentApprovalPause } from '../execution/subagentRuntime';
import type { Subagents } from './types';

/** State of a background sub-agent task. */
export type BackgroundTaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'awaiting-approval';

/** Options for the `subagents` of a lead agent, attached with {@link withSubagentOptions}. */
export interface SubagentOptions {
  /** How many background sub-agents of one lead run run at once (default 3). Further `background: true` calls queue. */
  maxConcurrent?: number;
}

/** What `agent_status` / `agent_await` report for a task. */
export interface BackgroundTaskView {
  taskId: string;
  agent: string;
  status: BackgroundTaskStatus | 'timeout';
  /** Milliseconds since the `task` call (until the task ended). */
  elapsedMs: number;
  /** The final answer, as the synchronous `task` result (`done`, `agent_await` only). */
  result?: string;
  /** Why it failed (`failed`). */
  error?: string;
  /** The child's pending approval (`awaiting-approval`). */
  approvalId?: string;
  toolName?: string;
}

interface BackgroundTask extends BackgroundTaskView {
  status: BackgroundTaskStatus;
  createdAt: number;
  endedAt?: number;
  controller: AbortController;
  launch: () => void;
  settled: Promise<void>;
  settle: () => void;
}

const DEFAULT_MAX_CONCURRENT = 3;
const optionsBySubagents = new WeakMap<object, SubagentOptions>();

/**
 * Attaches {@link SubagentOptions} to a `subagents` value and returns it, so
 * it can be passed to `createAgent({ subagents })` or `AgentExecutor.execute()`.
 *
 * @example
 * ```ts
 * const lead = createAgent({ provider, subagents: withSubagentOptions({ researcher }, { maxConcurrent: 2 }) });
 * ```
 */
export function withSubagentOptions<T extends Subagents>(subagents: T, options: SubagentOptions): T {
  const { maxConcurrent } = options;
  if (maxConcurrent !== undefined && !(Number.isInteger(maxConcurrent) && maxConcurrent >= 1)) {
    throw new Error(`withSubagentOptions: 'maxConcurrent' must be a whole number >= 1, got ${String(maxConcurrent)}.`);
  }
  optionsBySubagents.set(subagents, options);
  return subagents;
}

/** The options attached to `subagents` with {@link withSubagentOptions}. */
export function subagentOptionsOf(subagents: Subagents): SubagentOptions {
  return optionsBySubagents.get(subagents) ?? {};
}

/** The background tasks of one lead run. */
export class BackgroundTasks {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly queue: BackgroundTask[] = [];
  private running = 0;
  private watchedSignal: AbortSignal | undefined;

  constructor(private readonly maxConcurrent = DEFAULT_MAX_CONCURRENT) {}

  /**
   * Queues `run` (the child run, resolving to the `task` result text) and
   * starts it when a slot is free. Aborting `parentSignal` cancels every task.
   */
  start(agent: string, run: (signal: AbortSignal) => Promise<string>, parentSignal: AbortSignal | undefined): BackgroundTaskView {
    this.watch(parentSignal);
    const controller = new AbortController();
    let settle!: () => void;
    const task: BackgroundTask = {
      taskId: `task_${this.tasks.size + 1}`,
      agent,
      status: 'queued',
      elapsedMs: 0,
      createdAt: Date.now(),
      controller,
      settled: new Promise<void>((resolve) => (settle = resolve)),
      settle,
      launch: () => {
        this.running++;
        task.status = 'running';
        run(controller.signal).then(
          (result) => this.end(task, { status: 'done', result }),
          (error: unknown) => this.end(task, failure(error))
        );
      },
    };
    this.tasks.set(task.taskId, task);
    this.queue.push(task);
    if (parentSignal?.aborted) this.cancel(task.taskId);
    this.pump();
    return this.view(task);
  }

  /** One task, or all of them. */
  status(taskId?: string): BackgroundTaskView[] {
    const tasks = taskId === undefined ? [...this.tasks.values()] : [this.get(taskId)];
    return tasks.map((task) => ({ ...this.view(task), result: undefined }));
  }

  /** Waits until each task has ended or paused, or `timeoutMs` passed (those report `timeout`). */
  async wait(taskIds: readonly string[], timeoutMs: number | undefined, signal: AbortSignal | undefined): Promise<BackgroundTaskView[]> {
    const tasks = taskIds.map((id) => this.get(id));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waits: Promise<unknown>[] = [Promise.all(tasks.map((task) => task.settled))];
    if (timeoutMs !== undefined) waits.push(new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs))));
    if (signal) waits.push(new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })));
    await Promise.race(waits);
    clearTimeout(timer);
    return tasks.map((task) => (isActive(task) ? { ...this.view(task), status: 'timeout' } : this.view(task)));
  }

  /** Cancels a queued or running task; a task that already ended is left as is. */
  cancel(taskId: string): BackgroundTaskView {
    const task = this.get(taskId);
    if (isActive(task)) {
      const queued = this.queue.indexOf(task);
      if (queued !== -1) this.queue.splice(queued, 1);
      task.status = 'cancelled';
      task.endedAt = Date.now();
      task.controller.abort(new DOMException(`Background task ${taskId} was cancelled`, 'AbortError'));
      task.settle();
    }
    return this.view(task);
  }

  private watch(signal: AbortSignal | undefined): void {
    if (!signal || signal === this.watchedSignal) return;
    this.watchedSignal = signal;
    signal.addEventListener('abort', () => this.tasks.forEach((task) => this.cancel(task.taskId)), { once: true });
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      this.queue.shift()?.launch();
    }
  }

  private end(task: BackgroundTask, outcome: Pick<BackgroundTask, 'status' | 'result' | 'error' | 'approvalId' | 'toolName'>): void {
    this.running--;
    if (task.status === 'running') {
      Object.assign(task, outcome, { endedAt: Date.now() });
      task.settle();
    }
    this.pump();
  }

  private get(taskId: string): BackgroundTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      const known = [...this.tasks.keys()].join(', ') || 'none yet';
      throw new Error(`Unknown background task '${taskId}'. Known tasks: ${known}.`);
    }
    return task;
  }

  private view(task: BackgroundTask): BackgroundTaskView {
    const { taskId, agent, status, result, error, approvalId, toolName } = task;
    const elapsedMs = (task.endedAt ?? Date.now()) - task.createdAt;
    return { taskId, agent, status, elapsedMs, result, error, approvalId, toolName };
  }
}

function isActive(task: BackgroundTask): boolean {
  return task.status === 'queued' || task.status === 'running';
}

/** How a child run that threw is reported: paused for approval, or failed. */
function failure(error: unknown): Pick<BackgroundTask, 'status' | 'error' | 'approvalId' | 'toolName'> {
  if (error instanceof SubagentApprovalPause) {
    const pending = error.snapshot.pendingToolCall;
    return { status: 'awaiting-approval', approvalId: pending.id, toolName: pending.toolName };
  }
  return { status: 'failed', error: (error as Error | undefined)?.message ?? String(error) };
}
