/**
 * LOU-V3: runs the tool calls of one assistant turn concurrently, up to a
 * limit, while keeping everything the transcript and resumption depend on
 * deterministic. See `ExecuteOptions.toolConcurrency` for the public
 * contract; this module is the scheduler behind it.
 */

import type { ToolCall } from '../providers';
import type { PreparedToolCall, ToolCallOutcome } from './toolCallExecution';
import { ConfigurationError } from './errors';

/**
 * How many tool calls of one model turn may run at the same time:
 * a positive integer, or `'unbounded'` (all of them).
 */
export type ToolConcurrency = number | 'unbounded';

/**
 * Throws a descriptive error unless `value` is a valid {@link ToolConcurrency}
 * (`undefined` means "use the default" and is accepted).
 */
export function assertToolConcurrency(value: unknown, caller: string): void {
  if (value === undefined || value === 'unbounded') {
    return;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
    return;
  }
  throw new ConfigurationError(
    `${caller}: 'toolConcurrency' must be a positive integer or 'unbounded', got ${describe(value)}. ` +
      "Use 1 to run a turn's tool calls one at a time, e.g. { toolConcurrency: 4 } or { toolConcurrency: 'unbounded' }.", 'toolConcurrency');
}

function describe(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : String(value);
}

/** A tool call that has been started by {@link ToolBatchCallbacks.start}. */
export interface StartedToolCall {
  /** Settles once the call passed (or failed) its gate - see {@link PreparedToolCall}. */
  gate: Promise<PreparedToolCall>;
  /** Settles with the call's outcome (or its fatal error). */
  done: Promise<ToolCallOutcome>;
}

/** How the batch talks back to the executor. */
export interface ToolBatchCallbacks {
  /** Starts one call (emitting its `tool-call` event first). */
  start(toolCall: ToolCall): StartedToolCall;
  /** A call finished (completion order); never called for the approval call or a call paused for sign-in (N9b). */
  onComplete(outcome: ToolCallOutcome): void;
  /**
   * Records a result in the transcript; called as each call settles
   * (completion order). The transcript keeps the model's call order, so
   * the caller inserts the result where its call sits - a call that
   * finishes behind a slower earlier call is still recorded (and
   * checkpointed) at once, keyed by its toolCallId, so a crash resume
   * never runs it again.
   */
  record(toolCall: ToolCall, outcome: ToolCallOutcome): void;
  /** Persists the transcript after another result was recorded. */
  persist(): Promise<void>;
}

/** A call that was not appended to the transcript by the batch. */
export interface UnrecordedToolCall {
  toolCall: ToolCall;
  /** Its outcome, when it completed (it may be the approval outcome). */
  outcome?: ToolCallOutcome;
}

/** What happened to a batch, once no call of it is running any more. */
export interface ToolBatchResult {
  /** The first call (in call order) that needs approval; nothing after it ran. */
  approval?: { toolCall: ToolCall; outcome: ToolCallOutcome };
  /** The first fatal error, in call order (a `PropagatingToolError`, a throwing hook, ...). */
  failure?: { error: unknown };
  /** The calls, in order, whose results are not in the transcript. */
  unrecorded: UnrecordedToolCall[];
}

type Slot =
  | { status: 'not-started' | 'running' }
  | { status: 'completed'; outcome: ToolCallOutcome }
  | { status: 'failed'; error: unknown };

/** Hands out at most `limit` slots; waiters are served first-come first-served. N14: also limits the inner calls of one `run_code` script. */
export class Limiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }
}

/**
 * Runs one turn's tool calls. Calls are started in call order, each one
 * only after the previous one passed its gate (so the first call that needs
 * approval is known before anything after it starts) and a concurrency slot
 * is free. Each result is recorded as its call settles; the transcript
 * keeps call order. Resolves only once every started call has settled.
 */
class ToolBatch {
  private readonly slots: Slot[];
  private readonly limiter: Limiter;
  private readonly running: Array<Promise<void>> = [];
  private readonly recorded = new Set<number>();
  private halted = false;
  private persisting: Promise<void> = Promise.resolve();

  constructor(
    private readonly toolCalls: ToolCall[],
    concurrency: ToolConcurrency,
    private readonly callbacks: ToolBatchCallbacks,
    private readonly signal: AbortSignal | undefined
  ) {
    this.slots = toolCalls.map(() => ({ status: 'not-started' }));
    this.limiter = new Limiter(concurrency === 'unbounded' ? Infinity : concurrency);
  }

  async run(): Promise<ToolBatchResult> {
    for (const [index, toolCall] of this.toolCalls.entries()) {
      if (!(await this.acquireSlot())) {
        break;
      }
      await this.launch(index, toolCall);
    }
    await Promise.all(this.running);
    return this.result();
  }

  private stopped(): boolean {
    return this.halted || Boolean(this.signal?.aborted);
  }

  /** Waits for a free slot; false (slot returned) when the batch stopped meanwhile. */
  private async acquireSlot(): Promise<boolean> {
    if (this.stopped()) {
      return false;
    }
    await this.limiter.acquire();
    if (this.stopped()) {
      this.limiter.release();
      return false;
    }
    return true;
  }

  /** Starts a call and waits for its gate; halts the batch at an approval or a gate error. */
  private async launch(index: number, toolCall: ToolCall): Promise<void> {
    this.slots[index] = { status: 'running' };
    const started = this.callbacks.start(toolCall);
    this.running.push(this.track(index, started.done));
    try {
      const prepared = await started.gate;
      if (prepared.requiresApproval) {
        this.halted = true;
      }
    } catch {
      // The same error rejects `done`; track() records it.
      this.halted = true;
    }
  }

  /** Records a call's settlement; never rejects. Frees its slot afterwards. */
  private async track(index: number, done: Promise<ToolCallOutcome>): Promise<void> {
    try {
      const outcome = await done;
      this.slots[index] = { status: 'completed', outcome };
      // N9b: a call paused for sign-in has no result yet, like one awaiting approval.
      if (!outcome.requiresApproval && !outcome.signIn) {
        this.callbacks.onComplete(outcome);
        await this.record(index, outcome);
      }
    } catch (error) {
      this.slots[index] = { status: 'failed', error };
      this.halted = true;
    } finally {
      this.limiter.release();
    }
  }

  /** Records one settled call's result, then persists once it is in the transcript. */
  private async record(index: number, outcome: ToolCallOutcome): Promise<void> {
    this.callbacks.record(this.toolCalls[index], outcome);
    this.recorded.add(index);
    // Checkpoint writes are serialized so an older snapshot can never land
    // after a newer one.
    const write = this.persisting.then(() => this.callbacks.persist());
    this.persisting = write.catch(() => undefined);
    await write;
  }

  private result(): ToolBatchResult {
    const result: ToolBatchResult = { unrecorded: [] };
    for (const [index, slot] of this.slots.entries()) {
      const toolCall = this.toolCalls[index];
      if (slot.status === 'failed' && !result.failure) {
        result.failure = { error: slot.error };
      }
      if (slot.status === 'completed' && slot.outcome.requiresApproval) {
        result.approval = { toolCall, outcome: slot.outcome };
      }
      if (!this.recorded.has(index)) {
        result.unrecorded.push({ toolCall, ...(slot.status === 'completed' && { outcome: slot.outcome }) });
      }
    }
    return result;
  }
}

/** Runs one turn's tool calls - see {@link ToolBatch}. */
export function runToolBatch(
  toolCalls: ToolCall[],
  concurrency: ToolConcurrency,
  callbacks: ToolBatchCallbacks,
  signal?: AbortSignal
): Promise<ToolBatchResult> {
  return new ToolBatch(toolCalls, concurrency, callbacks, signal).run();
}
