/**
 * AgentSession (LOU-W4): a multi-turn conversation on top of the stateless
 * executor. The session owns the transcript and passes it in on every
 * `send()`. With a checkpoint store (LOU-W9), each turn also runs as a
 * durable-execution session, so a turn interrupted mid-way can be resumed.
 */

import { randomUUID } from 'node:crypto';
import type { Message } from '../providers/llm';
import { toMessages, type AgentInput } from '../providers/content';
import type { ExecutionResult } from '../execution/AgentExecutor';
import { startAgentRun, type AgentRun } from '../execution/agentRun';
import { InputQueue } from '../execution/inputQueue';
import { getCheckpointHistory, type Checkpoint, type CheckpointStore } from '../execution/checkpoint';
import type { ApprovalKind } from '../execution/ApprovalGate';
import { ConfigurationError, SDKError, SessionAwaitingApprovalError } from '../execution/errors';
import { streamSessionTurn } from './sessionStream';
import { MemorySessionStore, assertSessionId, encodeBytes, type SessionStore } from './sessionStore';
import { addSpent, runSpent, sessionSpent, type BudgetSpent, type RunLimits, type SessionBudget } from '../execution/budget';
import { restoreRunUsage } from '../execution/runUsage';
import { AGENT_EVENT_SCHEMA_VERSION, type AgentEvent, type AgentEventPayload } from '../execution/agentEvents';
import { manualCompactionOptions, type AgentCompaction } from '../context/agentCompaction';
import { compactTranscript, type SessionCompactOptions, type SessionCompactResult } from './sessionCompact';
import type { Principal } from '../auth/types';
import { forkTranscript, transcriptSteps, type SessionForkOptions, type SessionHistoryStep } from './sessionFork';

export type { SessionForkOptions, SessionHistoryStep } from './sessionFork';
import { assertPermissionMode, permissionModeOf, type PermissionMode, type PermissionOptions } from '../execution/permissions';

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
  /**
   * Budgets across all of the session's turns (LOU-V6), the same limits as
   * `createAgent({ limits })`: a turn stops with
   * `finishReason: 'budget-exceeded'` once the session's tokens, cost, steps
   * or run time reach a limit. What the turns spent is saved with the
   * transcript (`metadata.sessionUsage` of its last message), so it holds
   * for a session continued from its store. See docs/configuration.md#budgets.
   */
  limits?: RunLimits;
  /**
   * What a `send()` / `stream()` does while a turn is running or waiting to
   * start (LOU-V9). `'wait'` (default): it runs as the next turn once that one
   * ends. `'queue'`: its input joins that turn like `run.enqueue()` (before
   * that turn's next model call) and it resolves with that turn's result -
   * its own `signal` does not apply. `'steer'` (LOU-V10): it joins like
   * `'queue'`, but through `run.steer()`, so a model call that has not
   * emitted anything yet is aborted and made again with the input. A joining
   * `stream()` yields only the turn's `run.done`. If the turn ends before
   * taking the input, it runs as the next turn after all; if the turn fails,
   * it rejects with its error.
   */
  turnPolicy?: 'queue' | 'steer' | 'wait';
  /**
   * What `session.compact()` runs when called without a `strategy` (LOU-W8):
   * the same value as `createAgent({ compaction })` (its `strategy` or
   * `summarizer`, `protectedTokens`, `contextWindow`). `agent.session()`
   * defaults it to the agent's `compaction`. Default: prune old tool results.
   */
  compaction?: AgentCompaction;
  /**
   * The session's permission mode (N4) until `setPermissionMode()` switches
   * it. `agent.session()` defaults it to the agent's `permissionMode`. See
   * docs/permission-modes.md.
   */
  permissionMode?: PermissionOptions['permissionMode'];
  /** Called by `setPermissionMode()` (N4). `agent.session()` defaults it to the agent's `onPermissionModeChange`. */
  onPermissionModeChange?: PermissionOptions['onPermissionModeChange'];
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
  /** M10a: `'question'` when the turn waits on an `ask_question` call; absent for a tool approval (or a turn paused before this field existed). */
  approvalKind?: ApprovalKind;
}

/** Where a checkpointed session's turn is checkpointed: pass both to `AgentExecutor.execute()`. */
export interface SessionTurnCheckpoint {
  /** `<session id>.turn-<n>`, `n` being the transcript length when the turn started. */
  sessionId: string;
  checkpointStore: CheckpointStore;
}

/** How a session's turn runs: where it is checkpointed, and the session's budget (LOU-V6). */
export type SessionTurnOptions = Partial<SessionTurnCheckpoint> & {
  sessionBudget?: SessionBudget;
  inputQueue?: InputQueue;
  /** N4: the session's mode, read at each tool call of the turn. */
  permissionMode?: PermissionOptions['permissionMode'];
  /** LOU-R18: forwards the turn's events to the session's `on()` listeners. */
  onAgentEvent?: (event: AgentEvent) => void;
};

/** A turn's own user input and `metadata` (LOU-V15), for `createAgent()`'s per-run config; absent on a resumed turn. */
export interface SessionTurnCall {
  input: AgentInput;
  metadata?: Record<string, unknown>;
  /** The turn's caller (N10a). */
  principal?: Principal;
}

/** Options of `session.send()` / `session.stream()`. */
interface SessionSendOptions {
  signal?: AbortSignal;
  /** Passed to the agent's `model` / `instructions` / `tools` functions and memory scopes (LOU-V15). */
  metadata?: Record<string, unknown>;
  /** Who is calling (N10a, docs/auth.md); passed where `metadata` goes. Route auth does not check that this caller owns the session. */
  principal?: Principal;
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
  checkpoint?: SessionTurnOptions,
  call?: SessionTurnCall
) => Promise<ExecutionResult>;

/**
 * Streams one turn (LOU-V8): like {@link SessionRunner}, but returns the
 * run's `AgentRun`. Supplied by `createAgent()`.
 */
export type SessionStreamRunner = (
  input: Message[],
  signal?: AbortSignal,
  checkpoint?: SessionTurnOptions,
  call?: SessionTurnCall
) => AgentRun;

/**
 * Creates a session bound to the same agent (N3a), for `session.fork()`.
 * Supplied by `createAgent()`.
 */
export type SessionSpawner = (options: SessionOptions) => AgentSession;

/**
 * The queued work of a session, shared by every AgentSession object that
 * wraps the same `(store, id)` transcript in this process (e.g. two
 * `agent.session({ id })` objects, or the per-request objects a route
 * handler opens). Without it two objects' turns ran concurrently over the
 * same transcript and `commit()` overwrote the loser's turn silently
 * (last write won). Now they take turns, exactly like `send()` calls on
 * one object do. Different store objects over the same data (two processes,
 * or `fileStore(dir)` built twice) cannot share this queue; `commit()`
 * guards that case instead.
 */
const sessionQueues = new WeakMap<object, Map<string, Promise<unknown>>>();

/**
 * Runs `task` after everything queued before it under `(store, id)` in this
 * process (see `sessionQueues`). Sessions queue on their transcript store;
 * `agent.send(msg, { sessionId })` runs (Eve DUR-F2) on their checkpoint
 * store, so two concurrent calls with one id no longer both continue the same
 * 'finished' checkpoint and silently drop one turn.
 */
export function enqueueSessionWork<T>(store: object, id: string, task: () => Promise<T>): Promise<T> {
  let perStore = sessionQueues.get(store);
  if (!perStore) {
    perStore = new Map();
    sessionQueues.set(store, perStore);
  }
  const queue = perStore;
  const tail = queue.get(id) ?? Promise.resolve();
  const result = tail.then(task);
  const next = result.then(
    () => undefined,
    () => undefined
  );
  queue.set(id, next);
  // Drop the entry once the queue drains, so the map does not grow forever.
  void next.then(() => {
    if (queue.get(id) === next) queue.delete(id);
  });
  return result;
}

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
 * Eve EVE-0: the checkpoint id under which a session records its turn that
 * waits on an approval - a pointer to that turn's `<id>.turn-<n>` checkpoint,
 * so the pause is found whatever transcript (length) a caller sees.
 */
export function pausedTurnKey(id: string): string {
  return `${id}.paused`;
}

/**
 * Eve EVE-0: the session's turn that waits on an approval, found through its
 * {@link pausedTurnKey} pointer, or `null`. A pointer whose turn no longer
 * waits (decided, finished or discarded elsewhere) is deleted.
 */
export async function pausedSessionTurn(checkpointStore: CheckpointStore, id: string): Promise<Checkpoint | null> {
  const pointer = await checkpointStore.load(pausedTurnKey(id));
  if (!pointer) return null;
  const turn = await checkpointStore.load(pointer.sessionId);
  if (turn?.status === 'awaiting-approval') return turn;
  await checkpointStore.delete(pausedTurnKey(id));
  return null;
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

/** Whether two transcripts are the same (bytes compared by value). */
function sameTranscript(a: readonly Message[], b: readonly Message[]): boolean {
  return JSON.stringify(a, encodeBytes) === JSON.stringify(b, encodeBytes);
}

/** Whether `message` is the result a call got because the run stopped before it ran (`kind: 'not-run'`). */
function notRun(message: Message): boolean {
  if (message.role !== 'tool' || !message.isError || typeof message.content !== 'string') return false;
  try {
    return (JSON.parse(message.content) as { kind?: unknown } | null)?.kind === 'not-run';
  } catch {
    return false;
  }
}

/**
 * B4: what an aborted turn keeps: its `messages` up to the last result of a
 * tool call that ran in it (with the rest of that call's batch, so every call
 * is answered), or `undefined` when no tool call of the turn finished. A
 * side effect that happened is then in the transcript.
 */
function completedToolPrefix(messages: readonly Message[], previous: readonly Message[]): Message[] | undefined {
  const known = new Set(previous.flatMap((message) => (message.role === 'tool' && message.toolCallId ? [message.toolCallId] : [])));
  let last = messages.length - 1;
  while (last >= 0 && !(messages[last].role === 'tool' && !known.has(messages[last].toolCallId ?? '') && !notRun(messages[last]))) last -= 1;
  if (last < 0) return undefined;
  let end = last + 1;
  while (end < messages.length && messages[end].role === 'tool') end += 1;
  return messages.slice(0, end);
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
export class AgentSession<TObject = unknown> {
  readonly id: string;
  private readonly store: SessionStore;
  /** Set when every turn is checkpointed (LOU-W9). */
  protected readonly checkpointStore: CheckpointStore | undefined;
  private readonly run: SessionRunner;
  private readonly streamRun: SessionStreamRunner | undefined;
  private readonly limits: RunLimits | undefined;
  private readonly turnPolicy: SessionOptions['turnPolicy'];
  private readonly compaction: SessionOptions['compaction'];
  private readonly options: SessionOptions;
  private readonly spawn: SessionSpawner | undefined;
  private mode: SessionOptions['permissionMode'];
  private readonly onPermissionModeChange: SessionOptions['onPermissionModeChange'];
  /** N4: the session's mode at the time of the call; handed to every turn, so a switch applies from the next tool call. */
  protected readonly currentPermissionMode = (): PermissionMode => this.permissionMode;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  /**
   * LOU-R18: forwards a turn's event, as the run reports it, to the `on()`
   * listeners (a throwing listener is ignored). Protected so the approval
   * continuation (`resolveWith` / `streamResolveWith`) reports the resumed
   * run's events to them too.
   */
  protected readonly forwardToListeners = (event: AgentEvent): void => {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a listener must not break the session
      }
    }
  };

  /**
   * `forwardToListeners` for a run's `onAgentEvent` while the session has
   * listeners, `undefined` without - a listener-less turn needs no run sink.
   */
  protected get turnEvents(): ((event: AgentEvent) => void) | undefined {
    return this.listeners.size > 0 ? this.forwardToListeners : undefined;
  }
  /** The turn running (or about to run) and the queue its run takes input from (LOU-V9). */
  private running: { inputs: InputQueue; result: Promise<ExecutionResult> } | undefined;
  private turnStartedAt = 0;
  private transcript: Message[] = [];
  /** Whether `transcript` was read in the queued call running now (each call reads it again, Eve DUR-F3). */
  private loaded = false;

  constructor(run: SessionRunner, options: SessionOptions = {}, streamRun?: SessionStreamRunner, spawn?: SessionSpawner) {
    if (options.id !== undefined) assertSessionId(options.id);
    this.id = options.id ?? randomUUID();
    const stores = splitStores(options.store);
    this.store = stores.sessions ?? new MemorySessionStore();
    this.checkpointStore = options.checkpointStore ?? stores.checkpoints;
    this.limits = options.limits;
    this.turnPolicy = options.turnPolicy;
    this.compaction = options.compaction;
    if (typeof options.permissionMode === 'string') assertPermissionMode(options.permissionMode, 'agent.session');
    this.mode = options.permissionMode;
    this.onPermissionModeChange = options.onPermissionModeChange;
    this.run = run;
    this.streamRun = streamRun;
    this.options = options;
    this.spawn = spawn;
  }

  /**
   * Snapshot of the transcript so far (no system prompt). For a session
   * continued from a store it is empty until the first `send()` or
   * `load()` has completed.
   */
  get messages(): readonly Message[] {
    return structuredClone(this.transcript);
  }

  /** N4: the permission mode the session's next tool call runs under (`'default'` unless set). */
  get permissionMode(): PermissionMode {
    return permissionModeOf({ permissionMode: this.mode });
  }

  /**
   * Switches the session's permission mode (N4). It applies from the next
   * tool call, also in a turn that is running now, and to a paused turn
   * continued by `agent.approvals.resolve()`. A turn's system prompt is not
   * changed (only a turn that starts in plan mode is told about it). The switch
   * is reported to `onPermissionModeChange`. Not saved with the transcript.
   *
   * @example
   * ```ts
   * const session = agent.session({ permissionMode: 'plan' });
   * await session.send('Plan the refactor.');
   * session.setPermissionMode('acceptEdits');
   * await session.send('Apply the plan.');
   * ```
   */
  setPermissionMode(mode: PermissionMode): void {
    assertPermissionMode(mode, 'session.setPermissionMode');
    const from = this.permissionMode;
    this.mode = mode;
    this.onPermissionModeChange?.({ sessionId: this.id, from, to: mode, at: new Date().toISOString() });
  }

  /** Read the saved transcript from the store (done automatically by `send()`). */
  async load(): Promise<readonly Message[]> {
    await this.enqueue(async () => {
      await this.ensureLoaded();
      // A turn that finished but was never committed (e.g. its approval was
      // resolved by another process) joins the transcript here, exactly as
      // pending()/send()/resume() adopt it.
      await this.pendingCheckpoint();
    });
    return this.messages;
  }

  /**
   * Send a user message (a string, content parts or a `Message[]`, see
   * `AgentInput`) with the whole conversation so far. Concurrent calls
   * run one after another, in call order - also across `AgentSession`
   * objects that share this transcript's `(store, id)` in this process.
   * A turn that still loses the race against a writer the queue cannot see
   * (a different store object or process) fails with `LOUSHO_SESSION_BUSY`
   * instead of silently overwriting it; tool calls of it that ran are kept,
   * after the other writer's turn. Every call reads the transcript from the
   * store again, so a turn another session object committed is never lost.
   *
   * A call that throws or is aborted leaves the transcript as it was before
   * the call (an aborted call resolves with `finishReason: 'aborted'`),
   * except that an aborted call keeps the results of tool calls that already
   * ran (B4), so a side effect is never missing from the transcript.
   * In a checkpointed session, a pending turn is resumed first (see `resume()`).
   *
   * @example
   * ```ts
   * const result = await session.send('And in Paris?', { signal: AbortSignal.timeout(10_000) });
   * ```
   */
  send(input: AgentInput, options: SessionSendOptions = {}): Promise<ExecutionResult<TObject>> {
    return this.nextTurn(input, (inputs) => this.turn({ input, metadata: options.metadata, principal: options.principal }, inputs, options.signal)) as Promise<ExecutionResult<TObject>>;
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
  stream(input: AgentInput, options: SessionSendOptions = {}): AgentRun<TObject> {
    const streamRun = this.streamRun;
    if (!streamRun) {
      throw new SDKError(
        'This AgentSession was created without a streaming runner, so it cannot stream().',
        'LOUSHO_SESSION_STREAM_UNSUPPORTED'
      );
    }
    return streamSessionTurn(
      (signal, started, inputs) =>
        this.nextTurn(
          input,
          async () => {
            await this.beforeTurn(signal);
            const call = { input, metadata: options.metadata, principal: options.principal };
            const run = streamRun([...this.transcript, ...toMessages(input)], signal, this.turnOptions(inputs), call);
            started(run);
            return this.record(await run.result);
          },
          inputs,
          (joined) => started(startAgentRun(() => joined))
        ),
      options.signal
    ) as AgentRun<TObject>;
  }

  /**
   * The checkpointed turn that has not finished, or `null` (always `null`
   * without a checkpoint store). See docs/sessions.md, "Durable sessions".
   */
  pending(): Promise<PendingTurn | null> {
    return this.enqueue(async () => {
      const checkpoint = await this.pendingCheckpoint();
      if (!checkpoint) return null;
      this.foundPaused(checkpoint);
      const status = checkpoint.status === 'awaiting-approval' ? 'awaiting-approval' : 'in-progress';
      const { approvalId, approvalKind } = checkpoint;
      return { status, approvalId, ...(status === 'awaiting-approval' && approvalKind && { approvalKind }) };
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
      const pending = await this.pendingCheckpoint();
      if (!pending) return;
      await this.deleteCheckpoint();
      // Eve EVE-0: a paused turn another view of the session started (another transcript length) is dropped too.
      if (this.checkpointStore && pending.sessionId !== this.turnCheckpoint()?.sessionId) await this.checkpointStore.delete(pending.sessionId);
      await this.checkpointStore?.delete(pausedTurnKey(this.id));
    });
  }

  /**
   * Listens for the session's events (LOU-R18): every turn's events as the
   * turn runs - on `send()` as on `stream()`, and on a paused turn continued
   * by `agent.approvals.resolve()` - plus `compact()`'s `compaction.start` /
   * `compaction.done` and `clear()`'s `context.cleared`. A turn's events are
   * the `AgentEvent`s its `stream()` yields (`run.start`, `tool.start`, ...,
   * `run.done`), delivered synchronously as they happen, so a listener can
   * act on the rest of the turn (e.g. `setPermissionMode()` on `tool.start`,
   * see docs/permission-modes.md). Returns a function that removes the listener.
   *
   * @example
   * ```ts
   * session.on((event) => {
   *   if (event.type === 'tool.start') console.log('calling', event.toolName);
   * });
   * ```
   */
  on(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /**
   * Compacts the transcript now (LOU-W8), whatever its size: with
   * `options.strategy`, else the session's `compaction` option, else by
   * pruning old tool results. Saves the result to the store, emits
   * `compaction.start` / `compaction.done` with `trigger: 'manual'` to `on()`
   * listeners, and resolves with the before/after sizes. Pinned messages are
   * kept. An empty session resolves with zeros and emits nothing. Rejects with
   * `LOUSHO_SESSION_BUSY` while a turn is running and `LOUSHO_SESSION_TURN_PENDING`
   * (or `LOUSHO_SESSION_AWAITING_APPROVAL`) while a checkpointed turn is unfinished.
   *
   * @example
   * ```ts
   * const { tokensBefore, tokensAfter } = await session.compact({ protectedTokens: 2_000 });
   * ```
   */
  compact(options: SessionCompactOptions = {}): Promise<SessionCompactResult> {
    return this.idle(async () => {
      await this.ensureLoaded();
      await this.assertNoPendingTurn();
      const before = this.transcript;
      if (before.length === 0) return { messagesBefore: 0, messagesAfter: 0, tokensBefore: 0, tokensAfter: 0, strategy: 'none' };
      const { messages, result } = await compactTranscript(structuredClone(before), { ...manualCompactionOptions(this.compaction), ...options }, this.emitter());
      if (JSON.stringify(messages) !== JSON.stringify(before)) {
        await this.store.save(this.id, messages);
        this.transcript = messages;
      }
      return result;
    });
  }

  /**
   * Empties the transcript (LOU-W8) and saves the empty conversation. The
   * session keeps its id, its store and its options (limits, turn policy);
   * the transcript, every turn's checkpoint and checkpoint history (Eve
   * DUR-F8: they hold copies of the transcript, so `agent.fork('<id>.turn-<n>')`
   * cannot bring the conversation back) and the spend recorded in
   * the transcript for `limits` are gone. Memory slots are cross-session and
   * untouched. Emits `context.cleared` to `on()` listeners. Rejects with
   * `LOUSHO_SESSION_BUSY` while a turn is running and
   * `LOUSHO_SESSION_AWAITING_APPROVAL` while a checkpointed turn waits on an approval.
   */
  clear(): Promise<void> {
    return this.idle(async () => {
      await this.ensureLoaded();
      const pending = this.checkpointStore ? await this.pendingCheckpoint() : null;
      if (pending?.status === 'awaiting-approval') throw this.awaitingApproval(pending);
      await this.deleteTurnCheckpoints();
      await this.checkpointStore?.delete(pausedTurnKey(this.id));
      await this.store.delete(this.id);
      const messagesCleared = this.transcript.length;
      this.transcript = [];
      this.emitter()({ type: 'context.cleared', sessionId: this.id, messagesCleared });
    });
  }

  /**
   * The steps of the committed transcript, oldest first (N3a): one per model
   * response, with its tool calls and their results, numbered from 1 across
   * the whole session. A checkpointed turn that has not finished is not in
   * the transcript yet, so it is not listed. After `compact()` the steps are
   * those of the compacted transcript.
   *
   * @example
   * ```ts
   * for (const { step, turn, text, toolCalls } of await session.history()) {
   *   console.log(step, turn, text, toolCalls.map((call) => call.name));
   * }
   * ```
   */
  history(): Promise<SessionHistoryStep[]> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      await this.pendingCheckpoint();
      return transcriptSteps(structuredClone(this.transcript)).map(({ step }) => step);
    });
  }

  /**
   * Starts a new session from this one's transcript up to and including step
   * `fromStep` of `history()` (N3a), optionally with one tool result
   * replaced, saved under a new id in the same store and bound to the same
   * agent and options. This session is not changed. Only the conversation is
   * copied: a turn waiting on an approval or a question, or an interrupted
   * checkpointed turn, stays with this session, and workspace files and other
   * side effects are not rewound. Rejects with `LOUSHO_SESSION_BUSY` while a
   * turn is running, `LOUSHO_SESSION_STEP_NOT_FOUND` for a step outside
   * `0..history().length` and `LOUSHO_SESSION_EXISTS` for an `id` that is taken.
   *
   * @example
   * ```ts
   * const fork = await session.fork({ fromStep: 2 }); // id `${session.id}-fork-1`
   * const { text } = await fork.send('Try the other airport instead.');
   * ```
   */
  fork(options: SessionForkOptions): Promise<AgentSession<TObject>> {
    const spawn = this.spawn;
    if (!spawn) {
      return Promise.reject(
        new SDKError('This AgentSession was created without a way to create sessions, so it cannot fork().', 'LOUSHO_SESSION_FORK_UNSUPPORTED')
      );
    }
    return this.idle(async () => {
      await this.ensureLoaded();
      // A finished-but-uncommitted turn is part of the transcript a fork sees.
      await this.pendingCheckpoint();
      const messages = forkTranscript(this.transcript, options, this.id, providerValidPrefix);
      const id = options.id ?? (await this.nextForkId(messages.length));
      assertSessionId(id);
      if (id === this.id || (await this.isTaken(id, messages.length))) {
        throw new ConfigurationError(`fork: session '${id}' already exists; pick an id with no transcript in the store.`, 'id', 'LOUSHO_SESSION_EXISTS');
      }
      await this.store.save(id, messages);
      // This session's own stores (without `store`, each session has its own new MemorySessionStore) and current permission mode (N4).
      return spawn({ ...this.options, id, store: this.store, checkpointStore: this.checkpointStore, permissionMode: this.mode }) as AgentSession<TObject>;
    });
  }

  /** `<id>-fork-<n>` for the first `n` (from 1) that is not taken. */
  private async nextForkId(length: number): Promise<string> {
    for (let n = 1; ; n++) {
      const id = `${this.id}-fork-${n}`;
      if (!(await this.isTaken(id, length))) return id;
    }
  }

  /** `id` has a transcript, or a checkpointed turn that a fork of `length` messages would pick up as its own. */
  private async isTaken(id: string, length: number): Promise<boolean> {
    if ((await this.store.load(id)) !== undefined) return true;
    return Boolean(this.checkpointStore && (await this.checkpointStore.load(`${id}.turn-${length}`)));
  }

  /** Runs `task` after queued calls, unless a turn is running or queued now (`LOUSHO_SESSION_BUSY`). */
  private idle<T>(task: () => Promise<T>): Promise<T> {
    if (this.running) {
      return Promise.reject(new SDKError(`Session '${this.id}' has a turn in flight; wait for it to finish first.`, 'LOUSHO_SESSION_BUSY'));
    }
    return this.enqueue(task);
  }

  /** Reports a paused turn of this transcript (not one another view of the session started) to {@link pausedTurnFound}. */
  private foundPaused(checkpoint: Checkpoint): void {
    if (checkpoint.status === 'awaiting-approval' && checkpoint.approvalId && checkpoint.sessionId === this.turnCheckpoint()?.sessionId) {
      this.pausedTurnFound(checkpoint.approvalId);
    }
  }

  /**
   * Called when `pending()`, `resume()`, `send()` or `stream()` finds this session's turn waiting on approval
   * `approvalId` (coding-agent F2), so `agent.approvals.resolve()` continues it in this session.
   */
  protected pausedTurnFound(_approvalId: string): void {}

  private awaitingApproval({ sessionId, approvalId, approvalKind }: Checkpoint): SessionAwaitingApprovalError {
    return new SessionAwaitingApprovalError(sessionId || (this.turnCheckpoint()?.sessionId ?? this.id), approvalId, approvalKind);
  }

  private async assertNoPendingTurn(): Promise<void> {
    const pending = await this.pendingCheckpoint();
    if (!pending) return;
    if (pending.status === 'awaiting-approval') throw this.awaitingApproval(pending);
    throw new SDKError(`Session '${this.id}' has an interrupted turn; resume() or discardPending() it first.`, 'LOUSHO_SESSION_TURN_PENDING');
  }

  /** Sends events to the `on()` listeners (a throwing listener is ignored), numbered like one run's. */
  private emitter(): (payload: AgentEventPayload) => void {
    const runId = `session:${this.id}`;
    let seq = 0;
    return (payload) => {
      const event = { ...payload, runId, seq: seq++, timestamp: new Date().toISOString(), v: AGENT_EVENT_SCHEMA_VERSION } as AgentEvent;
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // a listener must not break the session
        }
      }
    };
  }

  /**
   * Runs `task` after everything queued before it - on this object AND on
   * every other AgentSession sharing this `(store, id)` transcript, so two
   * session objects cannot run turns concurrently (see `sessionQueues`).
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    return enqueueSessionWork(this.store, this.id, () => {
      // Eve DUR-F3: every queued call reads the transcript again, so turns that another session object (or
      // `agent.resume()` / `agent.approvals.resolve()`, which open their own) committed since are not lost on this one.
      this.loaded = false;
      return task();
    });
  }

  /** Reads the transcript from the store, once per queued call (see `enqueue`). */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.transcript = (await this.store.load(this.id)) ?? [];
    this.loaded = true;
  }

  private async turn(call: SessionTurnCall, inputs: InputQueue, signal?: AbortSignal): Promise<ExecutionResult> {
    await this.beforeTurn(signal);
    return this.record(await this.run([...this.transcript, ...toMessages(call.input)], signal, this.turnOptions(inputs), call));
  }

  /**
   * Runs `task` as the next turn, whose run takes queued input from `inputs`
   * (LOU-V9). Under `turnPolicy: 'queue'` (or `'steer'`, LOU-V10), while a
   * turn is running or about to run, `input` joins that turn instead (pushed
   * or steered) and this resolves with its result
   * (handed to `joined` first); if that turn ends before taking the input,
   * `task` runs as the next turn after all, unless the turn failed.
   */
  private nextTurn(
    input: AgentInput,
    task: (inputs: InputQueue) => Promise<ExecutionResult>,
    inputs = new InputQueue(),
    joined?: (result: Promise<ExecutionResult>) => void
  ): Promise<ExecutionResult> {
    const running = this.turnPolicy === 'queue' || this.turnPolicy === 'steer' ? this.running : undefined;
    if (running) {
      const taken = this.turnPolicy === 'steer' ? running.inputs.steer(input).joined : running.inputs.push(input).applied;
      return Promise.resolve(taken).then(async (applied) => {
        if (applied) {
          joined?.(running.result);
          return running.result;
        }
        // A turn that failed fails this call too (a checkpointed one keeps the input for `resume()`).
        await running.result;
        return this.nextTurn(input, task, inputs, joined);
      });
    }
    const turn = { inputs, result: this.enqueue(() => task(inputs)) };
    this.running = turn;
    inputs.closeAfter(turn.result);
    turn.result
      .finally(() => {
        if (this.running === turn) this.running = undefined;
      })
      .catch(() => undefined);
    return turn.result;
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
    return checkpointStore && { sessionId: `${this.id}.turn-${this.transcript.length}`, checkpointStore };
  }

  /** The next turn's checkpoint and, with `limits`, the session's budget (LOU-V6); starts the turn's clock. */
  private turnOptions(inputQueue?: InputQueue): SessionTurnOptions | undefined {
    this.turnStartedAt = Date.now();
    const checkpoint = { ...this.turnCheckpoint(), ...(inputQueue && { inputQueue }), permissionMode: this.currentPermissionMode, ...(this.turnEvents && { onAgentEvent: this.turnEvents }) };
    if (!this.limits) return checkpoint;
    return { ...checkpoint, sessionBudget: { limits: this.limits, spent: sessionSpent(this.transcript) } };
  }

  /**
   * Eve DUR-F8: deletes the checkpoint and checkpoint history of every turn of the session, `<id>.turn-<n>`. A turn's
   * `n` is the transcript length when it started, so `n` runs up to the transcript's length - or further, when a
   * compaction shortened it: every checkpoint found holds the transcript of its turn, whose length is a later turn's `n`.
   */
  private async deleteTurnCheckpoints(): Promise<void> {
    const { checkpointStore } = this;
    if (!checkpointStore) return;
    let last = this.transcript.length;
    for (let n = 0; n <= last; n++) {
      const id = `${this.id}.turn-${n}`;
      const saved = [await checkpointStore.load(id), ...((await getCheckpointHistory(checkpointStore, id)) ?? []).map((entry) => entry.checkpoint)];
      for (const checkpoint of saved) if (checkpoint) last = Math.max(last, checkpoint.messages.length);
      await checkpointStore.delete(id);
    }
  }

  private async deleteCheckpoint(): Promise<void> {
    const turn = this.turnCheckpoint();
    await turn?.checkpointStore.delete(turn.sessionId);
  }

  /** The pending turn's checkpoint. One that finished just before a crash is added to the transcript instead. */
  private async pendingCheckpoint(): Promise<Checkpoint | null> {
    await this.ensureLoaded();
    const turn = this.turnCheckpoint();
    if (!turn) return null;
    const checkpoint = await turn.checkpointStore.load(turn.sessionId);
    // Eve EVE-0: a turn waiting on an approval counts whatever transcript it started from.
    if (!checkpoint) return pausedSessionTurn(turn.checkpointStore, this.id);
    if (checkpoint.status !== 'finished') return checkpoint;
    await this.commit(checkpoint.messages, runSpent(restoreRunUsage(checkpoint.usage), checkpoint.stepIndex, 0));
    return null;
  }

  private async resumePending(signal?: AbortSignal): Promise<ExecutionResult | null> {
    const pending = await this.pendingCheckpoint();
    if (!pending) return null;
    if (pending.status === 'awaiting-approval') {
      this.foundPaused(pending);
      throw this.awaitingApproval(pending);
    }
    return this.record(await this.run([], signal, this.turnOptions()));
  }

  /**
   * Runs `next` as this session's next turn (after any queued `send()`) and
   * records the transcript it returns. `createAgent()` uses it to continue a
   * session whose turn paused for approval (LOU-D21).
   */
  protected continueTurn(next: () => Promise<ExecutionResult>): Promise<ExecutionResult> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      this.turnStartedAt = Date.now();
      return this.record(await next());
    });
  }

  /**
   * Eve EVE-0: points {@link pausedTurnKey} at this turn's checkpoint while it waits on an approval, so a new turn
   * under the session's id - `agent.send(msg, { sessionId })`, or a session object over another transcript - is
   * refused with `SessionAwaitingApprovalError` instead of running beside the paused one.
   */
  private async markPaused(): Promise<void> {
    const turn = this.turnCheckpoint();
    const checkpoint = turn && (await turn.checkpointStore.load(turn.sessionId));
    if (!turn || checkpoint?.status !== 'awaiting-approval') return;
    await turn.checkpointStore.save(pausedTurnKey(this.id), { ...checkpoint, messages: [], toolCalls: [], stepUsage: undefined, businessState: undefined });
  }

  private async record(result: ExecutionResult): Promise<ExecutionResult> {
    if (result.finishReason === 'aborted') {
      // B4: tool calls that ran (a refund, an email) stay in the transcript; the rest of the turn is dropped.
      const ran = completedToolPrefix(result.messages, this.transcript);
      if (ran) await this.commit(ran, runSpent(result.usage, result.steps, Date.now() - this.turnStartedAt));
      await this.deleteCheckpoint();
      return result;
    }
    // A checkpointed turn joins the transcript once, when it finishes; until then its checkpoint holds it.
    if (result.finishReason === 'awaiting-approval') {
      // Its spend is recorded once the turn finishes (the resumed result counts it all).
      if (!this.checkpointStore) await this.commit(result.messages);
      else await this.markPaused();
    } else {
      await this.commit(result.messages, runSpent(result.usage, result.steps, Date.now() - this.turnStartedAt));
    }
    return result;
  }

  /**
   * Saves `messages` (minus the system prompt) as the transcript, then drops
   * the finished turn's checkpoint - keeping its checkpoint HISTORY (the
   * ring a `checkpointStore.history()` store appends to), so the turn stays
   * forkable through `agent.fork('<id>.turn-<n>', { fromStep })` exactly like
   * a `send(msg, { sessionId })` run's 'finished' checkpoint does.
   * With `limits`, the last message records what the session has spent,
   * this turn included (LOU-V6).
   */
  private async commit(messages: readonly Message[], spent?: BudgetSpent): Promise<void> {
    const withoutSystem = messages[0]?.role === 'system' ? messages.slice(1) : messages;
    const next = providerValidPrefix(withoutSystem);
    const last = next.at(-1);
    if (this.limits && spent && last) {
      const sessionUsage = addSpent(sessionSpent(this.transcript), spent);
      next[next.length - 1] = { ...last, metadata: { ...last.metadata, sessionUsage } };
    }
    await this.assertBaseUnchanged(next);
    await this.store.save(this.id, next);
    const turn = this.turnCheckpoint();
    this.transcript = next;
    if (turn) await turn.checkpointStore.delete(turn.sessionId, { keepHistory: true });
  }

  /**
   * Optimistic concurrency for turns that CANNOT share this process's queue:
   * a second `SessionStore` object over the same transcript (another process,
   * or `fileStore(dir)` built twice). If the store no longer holds the
   * transcript this turn started from, committing would overwrite the other
   * writer's turn without an error - instead the turn's leftover checkpoint
   * is dropped (replaying it later would clobber the committed transcript
   * anyway) and the send fails with `LOUSHO_SESSION_BUSY`. Tool calls of the
   * turn that ran (an email, a refund) are not lost (Eve DUR-F3): the turn up
   * to their results is added after the other writer's transcript, as an
   * aborted turn keeps them (B4).
   */
  private async assertBaseUnchanged(next: readonly Message[]): Promise<void> {
    const stored = (await this.store.load(this.id)) ?? [];
    const base = this.transcript;
    if (sameTranscript(stored, base)) return;
    const turn = this.turnCheckpoint();
    if (turn) await turn.checkpointStore.delete(turn.sessionId, { keepHistory: true });
    const ran = sameTranscript(next.slice(0, base.length), base) ? completedToolPrefix(next, base) : undefined;
    if (ran) {
      const kept = [...stored, ...ran.slice(base.length)];
      await this.store.save(this.id, kept);
      this.transcript = kept;
    }
    throw new SDKError(
      `Session '${this.id}' was changed by another session object or process while this turn ran; ` +
        (ran ? "the turn was not committed, except its tool calls that ran, which were added after the other writer's turn. " : 'the turn was not committed. ') +
        'Reload the transcript and send again.',
      'LOUSHO_SESSION_BUSY'
    );
  }
}
