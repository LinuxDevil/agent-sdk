/**
 * LOU-V9: queued follow-up input. User input pushed while a run is going is
 * appended to the transcript at the run's next safe point - after the
 * current step's tool results, before the next model call - and the run
 * carries on as if the user had typed it.
 */

import { newId } from '../utils/id';
import { describeInput, toMessages, type AgentInput } from '../providers/content';
import type { Message } from '../providers';

/** What `run.enqueue()` / `InputQueue.push()` return. */
export interface EnqueueResult {
  /** The id the `input.queued` / `input.applied` events carry. */
  id: string;
  /**
   * `false` when the run had already finished: the input was not taken, so
   * send it as a new turn (`session.send()`). Otherwise a promise of `true`
   * once the input is in the transcript, or `false` when the run stopped
   * before its next model call (aborted, paused for approval, out of steps
   * or budget, failed) and the input is left to you - except that a failed
   * run with checkpointing keeps it in its checkpoint for `resume()`.
   */
  applied: false | Promise<boolean>;
}

/** An input waiting in an {@link InputQueue}. */
export interface QueuedInput {
  id: string;
  /** The input's user text (see `describeInput()`). */
  text: string;
  messages: Message[];
}

type Entry = QueuedInput & { settle: (applied: boolean) => void };

/**
 * Input for one run, pushed while it runs: pass it as
 * `ExecuteOptions.inputQueue` and call `push()` from anywhere (an
 * `AgentRun` has its own, behind `run.enqueue()`). One queue serves one run:
 * once that run ends, `push()` returns `{ applied: false }`.
 *
 * @example
 * ```ts
 * const inputQueue = new InputQueue();
 * const pending = AgentExecutor.execute({ agent, provider, input: 'Plan my trip.', inputQueue });
 * inputQueue.push('Also book a hotel.');
 * const result = await pending;
 * ```
 */
export class InputQueue {
  private entries: Entry[] = [];
  private closed = false;
  private listener: ((input: QueuedInput) => void) | undefined;

  /** Queues `input` for the run's next model call (see {@link EnqueueResult}). */
  push(input: AgentInput): EnqueueResult {
    const id = newId();
    if (this.closed) return { id, applied: false };
    let settle!: (applied: boolean) => void;
    const applied = new Promise<boolean>((resolve) => (settle = resolve));
    const entry: Entry = { id, text: describeInput(input), messages: [...toMessages(input)], settle };
    this.entries.push(entry);
    this.listener?.(entry);
    return { id, applied };
  }

  /** @internal The messages still waiting, in order (they ride at the end of checkpoints). */
  get messages(): Message[] {
    return this.entries.flatMap((entry) => entry.messages);
  }

  /** @internal Calls `listener` for each input queued so far and each one queued later. */
  listen(listener: (input: QueuedInput) => void): void {
    this.listener = listener;
    for (const entry of this.entries) listener(entry);
  }

  /** @internal Removes and returns the waiting inputs, marking them applied. */
  take(): QueuedInput[] {
    const taken = this.entries;
    this.entries = [];
    for (const entry of taken) entry.settle(true);
    return taken;
  }

  /** @internal Closes the queue once `run` settles, however it ends. */
  closeAfter(run: Promise<unknown>): void {
    run.finally(() => this.close()).catch(() => undefined);
  }

  /** @internal The run is over: inputs still waiting are not applied, later ones are refused. */
  close(): void {
    this.closed = true;
    for (const entry of this.entries) entry.settle(false);
    this.entries = [];
  }
}
