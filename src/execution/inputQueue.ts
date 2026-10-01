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

/**
 * What `run.steer()` / `InputQueue.steer()` return (LOU-V10). `applied` is
 * `'immediate'` when the in-flight model call had not produced any output
 * yet: it was aborted and is made again with the input; `'queued'` when it
 * had (or no model call was in flight): the input waits for the next safe
 * point like `enqueue()`; `false` when the run had already finished.
 */
export interface SteerResult {
  /** The id the `input.steered` / `input.applied` events carry. */
  id: string;
  applied: 'immediate' | 'queued' | false;
  /** Like {@link EnqueueResult.applied}: whether the input joined the transcript (`false` at once when `applied` is). */
  joined: Promise<boolean>;
}

/** An input waiting in an {@link InputQueue}. */
export interface QueuedInput {
  id: string;
  /** The input's user text (see `describeInput()`). */
  text: string;
  messages: Message[];
  /** LOU-V10: how a steered input was taken; absent for `push()`. */
  steered?: 'immediate' | 'queued';
}

type Entry = QueuedInput & { settle: (applied: boolean) => void };

/** @internal LOU-V10: the run's signal and a steer's, as one (either may be absent). */
export function withSteerSignal(signal: AbortSignal | undefined, steer: AbortSignal | undefined): AbortSignal | undefined {
  return signal && steer ? AbortSignal.any([signal, steer]) : (signal ?? steer);
}

/** LOU-V10: the reason a steer aborts the in-flight model call (or tool batch) with. */
const steeredAbort = () => new DOMException('The run was steered: new user input replaces this model call', 'AbortError');

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
  /** LOU-V10: the model call in flight (`output` once it emitted text or tool calls), or the running tool batch. */
  private call: { controller: AbortController; output: boolean } | undefined;
  private batch: AbortController | undefined;

  /** Queues `input` for the run's next model call (see {@link EnqueueResult}). */
  push(input: AgentInput): EnqueueResult {
    const id = newId();
    return { id, applied: this.closed ? false : this.add(id, input) };
  }

  /**
   * LOU-V10: queues `input` and redirects the run to it: a model call in
   * flight that has not emitted text or tool calls yet is aborted (its
   * partial output discarded) and made again with the input; tool calls of
   * a running batch that have not started are not run. See {@link SteerResult}.
   */
  steer(input: AgentInput): SteerResult {
    const id = newId();
    if (this.closed) return { id, applied: false, joined: Promise.resolve(false) };
    const call = this.call && !this.call.output ? this.call.controller : undefined;
    const applied = call ? 'immediate' : 'queued';
    const joined = this.add(id, input, applied);
    call?.abort(steeredAbort());
    this.batch?.abort(steeredAbort());
    return { id, applied, joined };
  }

  private add(id: string, input: AgentInput, steered?: QueuedInput['steered']): Promise<boolean> {
    let settle!: (applied: boolean) => void;
    const applied = new Promise<boolean>((resolve) => (settle = resolve));
    const entry: Entry = { id, text: describeInput(input), messages: [...toMessages(input)], ...(steered && { steered }), settle };
    this.entries.push(entry);
    this.listener?.(entry);
    return applied;
  }

  /** @internal LOU-V10: a model call starts; its signal aborts on `steer()` until `callOutput()`. */
  startCall(): AbortSignal {
    this.call = { controller: new AbortController(), output: false };
    return this.call.controller.signal;
  }

  /** @internal The model call emitted text or a tool call: a steer now waits for the next safe point. */
  callOutput(): void {
    if (this.call) this.call.output = true;
  }

  /** @internal A tool batch starts: its signal aborts on `steer()` (at once if a steered input waits). */
  startBatch(): AbortSignal {
    this.call = undefined;
    this.batch = new AbortController();
    if (this.entries.some((entry) => entry.steered)) this.batch.abort(steeredAbort());
    return this.batch.signal;
  }

  /** @internal The model call or tool batch is over. */
  endPhase(): void {
    this.call = undefined;
    this.batch = undefined;
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
