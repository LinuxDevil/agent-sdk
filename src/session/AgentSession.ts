/**
 * AgentSession (LOU-W4): a multi-turn conversation on top of the stateless
 * executor. The session owns the transcript and passes it in on every
 * `send()`. With a checkpoint store (LOU-W9), each turn also runs as a
 * durable-execution session, so a turn interrupted mid-way can be resumed.
 */

import { randomUUID } from 'node:crypto';
import type { Message } from '../providers/llm';
import type { ExecutionResult } from '../execution/AgentExecutor';
import type { AgentRun } from '../execution/agentRun';
import type { Checkpoint, CheckpointStore } from '../execution/checkpoint';
import { SessionAwaitingApprovalError } from '../execution/errors';
import { streamSessionTurn } from './sessionStream';
import { MemorySessionStore, assertSessionId, type SessionStore } from './sessionStore';

/** Options for `agent.session()`. */
export interface SessionOptions {
  /**
   * Session id (1-128 characters of `A-Za-z0-9_-`). Defaults to a generated
   * UUID. Passing an id that exists in `store` continues that conversation.
   */
  id?: string;
  /**
   * Where the transcript is kept. Defaults to a new `MemorySessionStore`.
   * A `{ sessions, checkpoints }` object (such as a `SqliteStore`) keeps the
   * transcript in `sessions` and checkpoints each turn in `checkpoints`.
   */
  store?: SessionStore | SessionStores;
  /**
   * Checkpoints every turn after each model response and tool result
   * (LOU-W9), so `resume()` can finish a turn that was interrupted (see
   * docs/sessions.md, "Durable sessions"). Overrides `store.checkpoints`.
   */
  checkpointStore?: CheckpointStore;
}

/** A transcript store plus, optionally, a checkpoint store (e.g. a `SqliteStore`). */
export interface SessionStores {
  sessions: SessionStore;
  checkpoints?: CheckpointStore;
}

/** A checkpointed session's turn that has not finished (see `session.pending()`). */
export interface PendingTurn {
  /** `'in-progress'`: interrupted, `resume()` continues it. `'awaiting-approval'`: decide `approvalId` first. */
  status: 'in-progress' | 'awaiting-approval';
  approvalId?: string;
}

/** Where a checkpointed session's turn is checkpointed: pass both to `AgentExecutor.execute()`. */
export interface SessionTurnCheckpoint {
  /** `<session id>.turn-<n>`, `n` being the transcript length when the turn started. */
  sessionId: string;
  checkpointStore: CheckpointStore;
}

/**
 * Runs one turn: `input` is the whole transcript so far, ending in the new
 * user message (or `[]` to resume the checkpointed turn). With `checkpoint`,
 * the turn must run with its `sessionId` and `checkpointStore`. Supplied by
 * `createAgent()`.
 */
export type SessionRunner = (
  input: Message[],
  signal?: AbortSignal,
  checkpoint?: SessionTurnCheckpoint
) => Promise<ExecutionResult>;

/**
 * Streams one turn (LOU-V8): like {@link SessionRunner}, but returns the
 * run's `AgentRun`. Supplied by `createAgent()`.
 */
export type SessionStreamRunner = (input: Message[], signal?: AbortSignal, checkpoint?: SessionTurnCheckpoint) => AgentRun;

/** `store` as its parts: a plain `SessionStore` is the transcript store. */
function splitStores(store: SessionOptions['store']): Partial<SessionStores> {
  if (!store) return {};
  return typeof (store as SessionStore).load === 'function' ? { sessions: store as SessionStore } : (store as SessionStores);
}

/**
 * `options` with the stores it does not give taken from `defaults` (an
 * agent's `store`, LOU-D30): `store` / `store.sessions` and
 * `checkpointStore` / `store.checkpoints` win over them.
 */
export function withDefaultStores(options: SessionOptions = {}, defaults: Partial<SessionStores> = {}): SessionOptions {
  const stores = splitStores(options.store);
  return {
    ...options,
    store: stores.sessions ?? defaults.sessions,
    checkpointStore: options.checkpointStore ?? stores.checkpoints ?? defaults.checkpoints,
  };
}

/**
 * Longest prefix of `messages` that a provider accepts: every assistant
 * tool-call turn is followed by a result for each of its calls, and no tool
 * message is orphaned.
 */
export function providerValidPrefix(messages: readonly Message[]): Message[] {
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (message.role === 'tool') break;
    const calls = message.role === 'assistant' ? (message.toolCalls ?? []) : [];
    if (calls.length === 0) {
      i += 1;
      continue;
    }
    let end = i + 1;
    const answered = new Set<string>();
    while (end < messages.length && messages[end].role === 'tool') {
      answered.add(messages[end].toolCallId ?? '');
      end += 1;
    }
    if (!calls.every((call) => answered.has(call.id))) break;
    i = end;
  }
  return messages.slice(0, i);
}

/**
 * A conversation that remembers earlier turns. Create one with
 * `agent.session()`.
 *
 * @example
 * ```ts
 * const session = agent.session();
 * await session.send('My name is Ali.');
 * const { text } = await session.send('What is my name?');
 * ```
 */
export class AgentSession {
  readonly id: string;
  private readonly store: SessionStore;
  /** Set when every turn is checkpointed (LOU-W9). */
  protected readonly checkpointStore: CheckpointStore | undefined;
  private readonly run: SessionRunner;
  private readonly streamRun: SessionStreamRunner | undefined;
  private history: Message[] = [];
  private loaded = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(run: SessionRunner, options: SessionOptions = {}, streamRun?: SessionStreamRunner) {
    if (options.id !== undefined) assertSessionId(options.id);
    this.id = options.id ?? randomUUID();
    const stores = splitStores(options.store);
    this.store = stores.sessions ?? new MemorySessionStore();
    this.checkpointStore = options.checkpointStore ?? stores.checkpoints;
    this.run = run;
    this.streamRun = streamRun;
  }

  /**
   * Snapshot of the transcript so far (no system prompt). For a session
   * continued from a store it is empty until the first `send()` or
   * `load()` has completed.
   */
  get messages(): readonly Message[] {
    return structuredClone(this.history);
  }

  /** Read the saved transcript from the store (done automatically by `send()`). */
  async load(): Promise<readonly Message[]> {
    await this.enqueue(() => this.ensureLoaded());
    return this.messages;
  }

  /**
   * Send a user message with the whole conversation so far. Concurrent calls
   * run one after another, in call order.
   *
   * A call that throws or is aborted leaves the transcript as it was before
   * the call (an aborted call resolves with `finishReason: 'aborted'`).
   * In a checkpointed session, a pending turn is resumed first (see `resume()`).
   *
   * @example
   * ```ts
   * const result = await session.send('And in Paris?', { signal: AbortSignal.timeout(10_000) });
   * ```
   */
  send(input: string, options: { signal?: AbortSignal } = {}): Promise<ExecutionResult> {
    return this.enqueue(() => this.turn(input, options.signal));
  }

  /**
   * Like `send()`, but streams the turn as the `AgentRun` that `agent.stream()`
   * returns (see docs/streaming.md). The turn waits for earlier calls, loads
   * the history and runs like `send()` does; once the run ends, the new user
   * message and the run's output are saved to the store exactly as `send()`
   * saves them, and only then is `run.done` delivered, so the transcript is
   * complete when the `for await` loop ends. `run.result` is `send()`'s result.
   *
   * Like `send()`, an aborted run (`signal`, or breaking out of the loop
   * early, unless the run had already finished), or one that fails, leaves
   * the transcript as it was. A run that
   * pauses for approval is saved up to the pause and continues with
   * `agent.approvals.resolve()`. If saving fails, `run.result` rejects and
   * the stream ends with `error` and `run.done` (`finishReason: 'error'`).
   *
   * @example
   * ```ts
   * for await (const event of session.stream('And in Paris?')) {
   *   if (event.type === 'text.delta') process.stdout.write(event.text);
   * }
   * ```
   */
  stream(input: string, options: { signal?: AbortSignal } = {}): AgentRun {
    const streamRun = this.streamRun;
    if (!streamRun) throw new Error('This AgentSession was created without a streaming runner, so it cannot stream().');
    return streamSessionTurn(
      (signal, started) =>
        this.enqueue(async () => {
          await this.beforeTurn(signal);
          const run = streamRun([...this.history, { role: 'user', content: input }], signal, this.turnCheckpoint());
          started(run);
          return this.record(await run.result);
        }),
      options.signal
    );
  }

  /**
   * The checkpointed turn that has not finished, or `null` (always `null`
   * without a checkpoint store). See docs/sessions.md, "Durable sessions".
   */
  pending(): Promise<PendingTurn | null> {
    return this.enqueue(async () => {
      const checkpoint = await this.pendingCheckpoint();
      if (!checkpoint) return null;
      const status = checkpoint.status === 'awaiting-approval' ? 'awaiting-approval' : 'in-progress';
      return { status, approvalId: checkpoint.approvalId };
    });
  }

  /**
   * Finishes a checkpointed turn that was interrupted (a crash, a failed
   * checkpoint write, a `PropagatingToolError`), without running recorded
   * tool calls or model responses again. The turn joins the transcript as
   * with `send()` and its result is returned; `null` when no turn is
   * pending. Throws `SessionAwaitingApprovalError` when the turn waits on an
   * approval: decide it with `agent.approvals.resolve()`.
   *
   * @example
   * ```ts
   * const session = agent.session({ id: 'user-42', store });
   * const finished = await session.resume(); // null when nothing was interrupted
   * ```
   */
  resume(options: { signal?: AbortSignal } = {}): Promise<ExecutionResult | null> {
    return this.enqueue(() => this.resumePending(options.signal));
  }

  /** Drops a pending turn without finishing it; the transcript stays as it was before that turn. */
  discardPending(): Promise<void> {
    return this.enqueue(async () => {
      if (await this.pendingCheckpoint()) await this.deleteCheckpoint();
    });
  }

  /** Forget the conversation (also deletes it, and a pending turn, from the store). */
  clear(): Promise<void> {
    return this.enqueue(async () => {
      if (this.checkpointStore) {
        await this.ensureLoaded();
        await this.deleteCheckpoint();
      }
      await this.store.delete(this.id);
      this.history = [];
      this.loaded = true;
      // A first turn that finished just before a crash, so was never adopted.
      await this.deleteCheckpoint();
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.history = (await this.store.load(this.id)) ?? [];
    this.loaded = true;
  }

  private async turn(input: string, signal?: AbortSignal): Promise<ExecutionResult> {
    await this.beforeTurn(signal);
    return this.record(await this.run([...this.history, { role: 'user', content: input }], signal, this.turnCheckpoint()));
  }

  /** Loads the history and, in a checkpointed session, finishes a pending turn first. */
  private async beforeTurn(signal?: AbortSignal): Promise<void> {
    const resumed = await this.resumePending(signal);
    if (resumed?.finishReason === 'awaiting-approval') {
      throw new SessionAwaitingApprovalError(this.turnCheckpoint()?.sessionId ?? this.id, resumed.approvalId);
    }
  }

  /** Where the next turn is checkpointed: keyed by the transcript length, so it is found again after a restart. */
  private turnCheckpoint(): SessionTurnCheckpoint | undefined {
    const { checkpointStore } = this;
    return checkpointStore && { sessionId: `${this.id}.turn-${this.history.length}`, checkpointStore };
  }

  private async deleteCheckpoint(): Promise<void> {
    const turn = this.turnCheckpoint();
    await turn?.checkpointStore.delete(turn.sessionId);
  }

  /** The pending turn's checkpoint. One that finished just before a crash is added to the transcript instead. */
  private async pendingCheckpoint(): Promise<Checkpoint | null> {
    await this.ensureLoaded();
    const turn = this.turnCheckpoint();
    const checkpoint = turn ? await turn.checkpointStore.load(turn.sessionId) : null;
    if (checkpoint?.status !== 'finished') return checkpoint;
    await this.commit(checkpoint.messages);
    return null;
  }

  private async resumePending(signal?: AbortSignal): Promise<ExecutionResult | null> {
    if (!(await this.pendingCheckpoint())) return null;
    return this.record(await this.run([], signal, this.turnCheckpoint()));
  }

  /**
   * Runs `next` as this session's next turn (after any queued `send()`) and
   * records the transcript it returns. `createAgent()` uses it to continue a
   * session whose turn paused for approval (LOU-D21).
   */
  protected continueTurn(next: () => Promise<ExecutionResult>): Promise<ExecutionResult> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      return this.record(await next());
    });
  }

  private async record(result: ExecutionResult): Promise<ExecutionResult> {
    if (result.finishReason === 'aborted') {
      await this.deleteCheckpoint();
      return result;
    }
    // A checkpointed turn joins the transcript once, when it finishes; until then its checkpoint holds it.
    if (!this.checkpointStore || result.finishReason !== 'awaiting-approval') await this.commit(result.messages);
    return result;
  }

  /** Saves `messages` (minus the system prompt) as the transcript, then drops the finished turn's checkpoint. */
  private async commit(messages: readonly Message[]): Promise<void> {
    const withoutSystem = messages[0]?.role === 'system' ? messages.slice(1) : messages;
    const next = providerValidPrefix(withoutSystem);
    await this.store.save(this.id, next);
    const turn = this.turnCheckpoint();
    this.history = next;
    if (turn) await turn.checkpointStore.delete(turn.sessionId);
  }
}
