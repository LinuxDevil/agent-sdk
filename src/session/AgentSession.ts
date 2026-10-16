/**
 * AgentSession: a multi-turn conversation on top of the stateless
 * executor. The session owns the transcript and passes it in on every
 * `send()`. With a checkpoint store, each turn also runs as a
 * durable-execution session, so a turn interrupted mid-way can be resumed.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Message } from '../providers/llm';
import { toMessages, type AgentInput } from '../providers/content';
import type { ExecutionResult } from '../execution/AgentExecutor';
import { startAgentRun, type AgentRun } from '../execution/agentRun';
import { InputQueue } from '../execution/inputQueue';
import { getCheckpointHistory, isCheckpointCorrupt, pausedApprovalIds, type Checkpoint, type CheckpointListEntry, type CheckpointStore } from '../execution/checkpoint';
import { acquireRunLease, HELD_RUN_LEASE, REPLACES_CHECKPOINT, type RunLease, type RunLeaseOptions } from '../execution/runLease';
import type { ApprovalKind } from '../execution/ApprovalGate';
import { ConfigurationError, LLMProviderError, SDKError, SessionAwaitingApprovalError } from '../execution/errors';
import { streamSessionTurn } from './sessionStream';
import { MemorySessionStore, assertSessionId, encodeBytes, transcriptRevision, type SessionStore } from './sessionStore';
import { addSpent, runSpent, sessionSpent, type BudgetSpent, type RunLimits, type SessionBudget } from '../execution/budget';
import { restoreRunUsage } from '../execution/runUsage';
import { checkpointError } from '../execution/runFailure';
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
   * Checkpoints every turn after each model response and tool result,
   * so `resume()` can finish a turn that was interrupted (see
   * docs/sessions.md, "Durable sessions"). Overrides `store.checkpoints`.
   */
  checkpointStore?: CheckpointStore;
  /**
   * Budgets across all of the session's turns, the same limits as
   * `createAgent({ limits })`: a turn stops with
   * `finishReason: 'budget-exceeded'` once the session's tokens, cost, steps
   * or run time reach a limit. What the turns spent is saved with the
   * transcript (`metadata.sessionUsage` of its last message), so it holds
   * for a session continued from its store. See docs/configuration.md#budgets.
   */
  limits?: RunLimits;
  /**
   * What a `send()` / `stream()` does while a turn is running or waiting to
   * start. `'wait'` (default): it runs as the next turn once that one
   * ends. `'queue'`: its input joins that turn like `run.enqueue()` (before
   * that turn's next model call) and it resolves with that turn's result -
   * its own `signal` does not apply. `'steer'`: it joins like
   * `'queue'`, but through `run.steer()`, so a model call that has not
   * emitted anything yet is aborted and made again with the input. A joining
   * `stream()` yields only the turn's `run.done`. If the turn ends before
   * taking the input, it runs as the next turn after all; if the turn fails,
   * it rejects with its error.
   */
  turnPolicy?: 'queue' | 'steer' | 'wait';
  /**
   * What `session.compact()` runs when called without a `strategy`:
   * the same value as `createAgent({ compaction })` (its `strategy` or
   * `summarizer`, `protectedTokens`, `contextWindow`). `agent.session()`
   * defaults it to the agent's `compaction`. Default: prune old tool results.
   */
  compaction?: AgentCompaction;
  /**
   * The session's permission mode until `setPermissionMode()` switches
   * it. `agent.session()` defaults it to the agent's `permissionMode`. See
   * docs/permission-modes.md.
   */
  permissionMode?: PermissionOptions['permissionMode'];
  /** Called by `setPermissionMode()`. `agent.session()` defaults it to the agent's `onPermissionModeChange`. */
  onPermissionModeChange?: PermissionOptions['onPermissionModeChange'];
  /**
   * In a checkpointed session, how many of the latest committed turns keep their
   * checkpoint history, so `agent.fork('<id>.turn-<n>', { fromStep })` can fork
   * them (default 10; `0` keeps none). Every history entry holds a copy of the
   * whole transcript, so older turns' histories are deleted as new turns
   * commit. `session.fork()` works from the transcript and is not affected.
   */
  turnHistoryLimit?: number;
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
  /** With `'awaiting-approval'`, when the paused step waits on several calls: every one not decided yet (`approvalId` is the first). */
  approvalIds?: string[];
  /** `'question'` when the turn waits on an `ask_question` call; absent for a tool approval (or a turn paused before this field existed). */
  approvalKind?: ApprovalKind;
}

/** Where a checkpointed session's turn is checkpointed: pass both to `AgentExecutor.execute()`. */
export interface SessionTurnCheckpoint {
  /** `<session id>.turn-<n>`, `n` being the transcript length when the turn started. */
  sessionId: string;
  checkpointStore: CheckpointStore;
}

/** How a session's turn runs: where it is checkpointed, and the session's budget. */
export type SessionTurnOptions = Partial<SessionTurnCheckpoint> & {
  sessionBudget?: SessionBudget;
  inputQueue?: InputQueue;
  /** The session's mode, read at each tool call of the turn. */
  permissionMode?: PermissionOptions['permissionMode'];
  /** Forwards the turn's events to the session's `on()` listeners. */
  onAgentEvent?: (event: AgentEvent) => void;
};

/** A turn's own user input and `metadata`, for `createAgent()`'s per-run config; absent on a resumed turn. */
export interface SessionTurnCall {
  input: AgentInput;
  metadata?: Record<string, unknown>;
  /** The turn's caller. */
  principal?: Principal;
}

/** A new turn's input and call, kept when its first model call fails (see `AgentSession.unstartedTurn`). */
interface FailedTurnInput {
  input: Message[];
  call: SessionTurnCall;
}

/** Options of `session.send()` / `session.stream()`. */
interface SessionSendOptions {
  signal?: AbortSignal;
  /** Passed to the agent's `model` / `instructions` / `tools` functions and memory scopes. */
  metadata?: Record<string, unknown>;
  /** Who is calling (docs/auth.md); passed where `metadata` goes. Route auth does not check that this caller owns the session. */
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
 * Streams one turn: like {@link SessionRunner}, but returns the
 * run's `AgentRun`. Supplied by `createAgent()`.
 */
export type SessionStreamRunner = (
  input: Message[],
  signal?: AbortSignal,
  checkpoint?: SessionTurnOptions,
  call?: SessionTurnCall
) => AgentRun;

/**
 * Creates a session bound to the same agent, for `session.fork()`.
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
 * `agent.send(msg, { sessionId })` runs on their checkpoint
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

/** What a paused turn without a checkpoint store remembers in-process. */
interface InMemoryPause {
  approvalId?: string;
  approvalIds?: string[];
  approvalKind?: ApprovalKind;
}

/**
 * a session WITHOUT a checkpointStore has nowhere durable to mark a
 * paused turn, so its own pause was invisible to the next `send()` — which
 * ran over the truncated transcript, and the later `approvals.resolve()`
 * clobbered that committed turn. Kept per `(store, id)` like `sessionQueues`,
 * so every AgentSession object over the transcript in this process sees it.
 * Across processes there is still nothing to read: a session that may pause
 * needs a `checkpointStore` for a durable marker.
 */
const inMemoryPauses = new WeakMap<object, Map<string, InMemoryPause>>();

function inMemoryPause(store: object, id: string): InMemoryPause | undefined {
  return inMemoryPauses.get(store)?.get(id);
}

function markInMemoryPause(store: object, id: string, paused: InMemoryPause | undefined): void {
  if (paused === undefined) {
    inMemoryPauses.get(store)?.delete(id);
    return;
  }
  let perStore = inMemoryPauses.get(store);
  if (!perStore) inMemoryPauses.set(store, (perStore = new Map()));
  perStore.set(id, paused);
}

/** Every approval id of a pause (`approvalIds` when there are several, else `approvalId`). */
function pauseApprovalIds(paused: InMemoryPause): string[] {
  return paused.approvalIds ?? (paused.approvalId ? [paused.approvalId] : []);
}

/** The `pending()` view of an in-process pause (no checkpoint store). */
function inMemoryPending(paused: InMemoryPause): PendingTurn {
  const approvalIds = pauseApprovalIds(paused);
  return {
    status: 'awaiting-approval',
    approvalId: paused.approvalId,
    ...(approvalIds.length > 1 && { approvalIds }),
    ...(paused.approvalKind && { approvalKind: paused.approvalKind }),
  };
}

/**
 * `<id>.turn-counter`, a tiny checkpoint that persists how high the
 * turn checkpoint numbering has gone (`stepIndex` = the smallest `n` still
 * guaranteed unused). A compaction shortens the transcript, so numbering
 * turns by transcript length reused `<id>.turn-<n>` and `fork()` silently
 * resolved to a different turn.
 */
function turnCounterKey(id: string): string {
  return `${id}.turn-counter`;
}

/** The {@link turnCounterKey} record: only `stepIndex` carries meaning (the high-water mark). */
function turnCounterCheckpoint(id: string, highWater: number): Checkpoint {
  return {
    agentId: '',
    sessionId: turnCounterKey(id),
    stepIndex: highWater,
    messages: [],
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    status: 'finished',
  };
}

/** `store` as its parts: a plain `SessionStore` is the transcript store. */
function splitStores(store: SessionOptions['store']): Partial<SessionStores> {
  if (!store) return {};
  return typeof (store as SessionStore).load === 'function' ? { sessions: store as SessionStore } : (store as SessionStores);
}

/**
 * `options` with the stores it does not give taken from `defaults` (an
 * agent's `store`): `store` / `store.sessions` and
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

/** How many committed turns keep their checkpoint history by default (see `SessionOptions.turnHistoryLimit`). */
const DEFAULT_TURN_HISTORY_LIMIT = 10;

/** Most turns of older history (backlog) whose history one commit deletes (see `dropOldTurnHistory`). */
const DROPPED_TURNS_PER_COMMIT = 32;

/**
 * How many of the newest turn starts outside the window every commit deletes,
 * whatever earlier commits did (see `dropOldTurnHistory`): the turn that just
 * left the window, and its queued input.
 */
const LEFT_WINDOW_PER_COMMIT = 8;

/**
 * Per checkpoint store and session id: the transcript index below which every
 * turn's checkpoint history is known to be deleted (see `dropOldTurnHistory`).
 */
const droppedTurnHistory = new WeakMap<CheckpointStore, Map<string, number>>();

/** `null` for a checkpoint that cannot be read (`LOUSHO_CHECKPOINT_CORRUPT`); any other error is rethrown. */
function ignoreCorrupt(error: unknown): null {
  if (isCheckpointCorrupt(error)) return null;
  throw error;
}

/**
 * The checkpoint id under which a session records its turn that
 * waits on an approval - a pointer to that turn's `<id>.turn-<n>` checkpoint,
 * so the pause is found whatever transcript (length) a caller sees.
 */
function pausedTurnKey(id: string): string {
  return `${id}.paused`;
}

/**
 * The session's turn that waits on an approval, found through its
 * {@link pausedTurnKey} pointer, or `null`. A pointer whose turn no longer
 * waits (decided, finished or discarded elsewhere) is deleted.
 * Without a live pointer, the turn checkpoints themselves are scanned
 * (see {@link pausedTurnScan}) - `markPaused()` writes the pointer AFTER the
 * executor saved the paused checkpoint, so a crash between the two writes (or a
 * send that slipped into the gap) leaves the pause with no pointer, permanently.
 */
export async function pausedSessionTurn(checkpointStore: CheckpointStore, id: string): Promise<Checkpoint | null> {
  const pointer = await checkpointStore.load(pausedTurnKey(id));
  if (pointer) {
    const turn = await checkpointStore.load(pointer.sessionId);
    if (turn?.status === 'awaiting-approval') return turn;
    await checkpointStore.delete(pausedTurnKey(id));
  }
  return pausedTurnScan(checkpointStore, id);
}

/**
 * The newest `<id>.turn-<n>` checkpoint that still waits on an approval,
 * or `null` - the fallback when the {@link pausedTurnKey} pointer is missing
 * (see {@link pausedSessionTurn}). A store that cannot `list()` keeps the
 * pointer's behavior.
 */
async function pausedTurnScan(checkpointStore: CheckpointStore, id: string): Promise<Checkpoint | null> {
  if (!checkpointStore.list) return null;
  let listed: CheckpointListEntry[];
  try {
    listed = await checkpointStore.list({ status: 'awaiting-approval' });
  } catch {
    return null; // A store whose list() is unavailable (e.g. a KV binding without it) keeps the pointer's behavior.
  }
  const prefix = `${id}.turn-`;
  let paused: Checkpoint | null = null;
  let latest = -1;
  for (const entry of listed) {
    if (!entry.sessionId.startsWith(prefix)) continue;
    const n = Number(entry.sessionId.slice(prefix.length));
    if (!Number.isInteger(n) || n <= latest) continue;
    latest = n;
    paused = entry.checkpoint;
  }
  return paused;
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

/** `turnHistoryLimit`, validated: a whole number >= 0. */
function turnHistoryLimitOf(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TURN_HISTORY_LIMIT;
  if (Number.isInteger(value) && value >= 0) return value;
  throw new ConfigurationError(`agent.session: 'turnHistoryLimit' must be a whole number >= 0, got ${String(value)}.`, 'turnHistoryLimit');
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
 * What an aborted turn keeps: its `messages` up to the last result of a
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
 * What an aborted turn leaves in the transcript: the user's input, the turn up to the last tool call
 * that ran (a refund, an email), and the reply the model had streamed when it was stopped (an assistant message
 * marked `metadata.interrupted`). Calls that never ran and an assistant tool-call turn none of whose calls ran are
 * dropped, and so is a turn stopped before it called the model. `undefined` when the turn added nothing.
 */
function abortedTurn(result: ExecutionResult, transcript: readonly Message[], input: readonly Message[]): Message[] | undefined {
  const { messages } = result;
  const all = messages[0]?.role === 'system' ? messages.slice(1) : messages;
  // A turn stopped before its first model call (an already-aborted signal) is dropped whole.
  const kept = completedToolPrefix(all, transcript) ?? (result.usage.modelCalls > 0 ? [...transcript, ...input] : [...transcript]);
  const last = all.at(-1);
  if (last?.role === 'assistant' && last.metadata?.interrupted === true && all.length > kept.length) kept.push(last);
  return kept.length > transcript.length ? kept : undefined;
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
  /** Set when every turn is checkpointed. */
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
  private readonly turnHistoryLimit: number;
  /** The session's mode at the time of the call; handed to every turn, so a switch applies from the next tool call. */
  protected readonly currentPermissionMode = (): PermissionMode => this.permissionMode;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  /**
   * Forwards a turn's event, as the run reports it, to the `on()`
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
  /** The turn running (or about to run) and the queue its run takes input from. */
  private running: { inputs: InputQueue; result: Promise<ExecutionResult> } | undefined;
  /** The run lease this session's turn holds on its checkpoint id, from before the run starts until its `record()` is done. */
  private turnLease: RunLease | undefined;
  private turnStartedAt = 0;
  private transcript: Message[] = [];
  /** Whether `transcript` was read in the queued call running now (each call reads it again). */
  private loaded = false;
  /**
   * the `n` of the in-flight turn's `<id>.turn-<n>` checkpoint, and
   * the smallest `n` still guaranteed unused (persisted in the
   * {@link turnCounterKey} checkpoint). Numbering turns by transcript length
   * alone collided after a `compact()` shortened it.
   */
  private turnIndex: number | undefined;
  private turnHighWater: number | undefined;

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
    this.turnHistoryLimit = turnHistoryLimitOf(options.turnHistoryLimit);
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

  /** The permission mode the session's next tool call runs under (`'default'` unless set). */
  get permissionMode(): PermissionMode {
    return permissionModeOf({ permissionMode: this.mode });
  }

  /**
   * Switches the session's permission mode. It applies from the next
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
   * A call that throws leaves the transcript as it was before the call. An
   * aborted call resolves with `finishReason: 'aborted'` and keeps the user's
   * message (once the model was called), the results of tool calls that
   * already ran and the reply streamed so far, marked
   * `metadata.interrupted`.
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
            const messages = toMessages(input);
            const turn = this.turnOptions(inputs);
            await this.holdRunLease(turn);
            try {
              const run = streamRun([...this.transcript, ...messages], signal, turn, call);
              started(run);
              return this.record(await this.attempt(() => run.result, { input: messages, call }), messages);
            } finally {
              await this.releaseRunLease();
            }
          },
          inputs,
          (joined) => started(startAgentRun(() => joined))
        ),
      options.signal
    ) as AgentRun<TObject>;
  }

  /**
   * The checkpointed turn that has not finished, or `null`. A session without
   * a checkpoint store reports its in-process pause (a turn waiting on an
   * approval since this store saw it) here too. See docs/sessions.md,
   * "Durable sessions".
   */
  pending(): Promise<PendingTurn | null> {
    return this.enqueue(async () => {
      const checkpoint = await this.pendingCheckpoint();
      // report the in-memory pause of a session without a checkpoint store too.
      if (!checkpoint) {
        const paused = inMemoryPause(this.store, this.id);
        return paused ? inMemoryPending(paused) : null;
      }
      this.foundPaused(checkpoint);
      const status = checkpoint.status === 'awaiting-approval' ? 'awaiting-approval' : 'in-progress';
      const { approvalId, approvalKind } = checkpoint;
      const approvalIds = status === 'awaiting-approval' ? pausedApprovalIds(checkpoint) : [];
      return { status, approvalId, ...(approvalIds.length > 1 && { approvalIds }), ...(status === 'awaiting-approval' && approvalKind && { approvalKind }) };
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
    return this.enqueue(() => this.resumePending(options.signal, true));
  }

  /** Drops a pending turn without finishing it; the transcript stays as it was before that turn. */
  discardPending(): Promise<void> {
    return this.enqueue(async () => {
      let pending: Checkpoint | null;
      try {
        pending = await this.pendingCheckpoint();
      } catch (error) {
        if (!isCheckpointCorrupt(error)) throw error;
        // A checkpoint that cannot be read is dropped too: it is the only way out of it.
        return this.discardUnreadable();
      }
      if (!pending) {
        // dropping the in-memory pause of a session without a checkpoint store.
        const paused = inMemoryPause(this.store, this.id);
        if (!paused) return;
        markInMemoryPause(this.store, this.id, undefined);
        // Its approvals can never continue it now: they are withdrawn.
        await this.pendingTurnDiscarded(pauseApprovalIds(paused));
        return;
      }
      await this.deleteCheckpoint();
      // A paused turn another view of the session started (another transcript length) is dropped too.
      if (this.checkpointStore && pending.sessionId !== this.turnCheckpoint()?.sessionId) await this.checkpointStore.delete(pending.sessionId);
      await this.checkpointStore?.delete(pausedTurnKey(this.id));
      // Its approvals can never continue it now: they are withdrawn, so they are not listed or decided any more.
      if (pending.status === 'awaiting-approval') await this.pendingTurnDiscarded(pausedApprovalIds(pending));
    });
  }

  /** Drops this transcript's turn checkpoint and the paused-turn pointer (and its turn), whichever cannot be read. */
  private async discardUnreadable(): Promise<void> {
    const { checkpointStore } = this;
    if (!checkpointStore) return;
    await this.deleteCheckpoint();
    const pointer = await checkpointStore.load(pausedTurnKey(this.id)).catch(ignoreCorrupt);
    if (pointer) await checkpointStore.delete(pointer.sessionId);
    await checkpointStore.delete(pausedTurnKey(this.id));
  }

  /** Called with the approvals of a paused turn `discardPending()` dropped; `createAgent()` withdraws them from its approval store. */
  protected async pendingTurnDiscarded(_approvalIds: string[]): Promise<void> {}

  /**
   * Listens for the session's events: every turn's events as the
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
   * Compacts the transcript now, whatever its size: with
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
        // the shorter transcript must not lower the next turn's n below turnHighWater.
        this.turnIndex = undefined;
      }
      return result;
    });
  }

  /**
   * Empties the transcript and saves the empty conversation. The
   * session keeps its id, its store and its options (limits, turn policy);
   * the transcript, every turn's checkpoint and checkpoint history (they hold copies of the transcript, so `agent.fork('<id>.turn-<n>')`
   * cannot bring the conversation back) and the spend recorded in
   * the transcript for `limits` are gone. Memory slots are cross-session and
   * untouched. Emits `context.cleared` to `on()` listeners. Rejects with
   * `LOUSHO_SESSION_BUSY` while a turn is running and
   * `LOUSHO_SESSION_AWAITING_APPROVAL` while a checkpointed turn waits on an approval.
   */
  clear(): Promise<void> {
    return this.idle(async () => {
      try {
        await this.ensureLoaded();
      } catch (error) {
        // A transcript file that cannot be read is what clear() removes.
        if (!(error instanceof SDKError && error.code === 'LOUSHO_SESSION_FILE_CORRUPT')) throw error;
        this.transcript = [];
        this.loaded = true;
      }
      const pending = this.checkpointStore ? await this.pendingCheckpoint().catch(ignoreCorrupt) : null;
      if (pending?.status === 'awaiting-approval') throw this.awaitingApproval(pending);
      const paused = inMemoryPause(this.store, this.id);
      if (paused) throw new SessionAwaitingApprovalError(this.id, paused.approvalId, paused.approvalKind);
      await this.deleteTurnCheckpoints();
      if (this.checkpointStore) await this.discardUnreadable();
      await this.checkpointStore?.delete(pausedTurnKey(this.id));
      markInMemoryPause(this.store, this.id, undefined);
      await this.store.delete(this.id);
      const messagesCleared = this.transcript.length;
      this.transcript = [];
      this.turnIndex = undefined;
      this.emitter()({ type: 'context.cleared', sessionId: this.id, messagesCleared });
    });
  }

  /**
   * The steps of the committed transcript, oldest first: one per model
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
   * `fromStep` of `history()`, optionally with one tool result
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
      // This session's own stores (without `store`, each session has its own new MemorySessionStore) and current permission mode.
      const fork = spawn({ ...this.options, id, store: this.store, checkpointStore: this.checkpointStore, permissionMode: this.mode }) as AgentSession<TObject>;
      // The fork's `messages` are its transcript at once, without a `load()`.
      fork.transcript = structuredClone(messages);
      return fork;
    });
  }

  /**
   * `<id>-fork-<n>` for the first `n` (from 1) that is not taken. when that is longer than a session id
   * may be (128 characters), `<id prefix>-<8 hex of the id's hash>-fork-<n>` instead, so a long id can be forked too.
   */
  private async nextForkId(length: number): Promise<string> {
    for (let n = 1; ; n++) {
      const suffix = `-fork-${n}`;
      const id =
        this.id.length + suffix.length <= 128
          ? `${this.id}${suffix}`
          : `${this.id.slice(0, 128 - suffix.length - 9)}-${createHash('sha256').update(this.id).digest('hex').slice(0, 8)}${suffix}`;
      if (!(await this.isTaken(id, length))) return id;
    }
  }

  /** `id` has a transcript, or a checkpointed turn that a fork of `length` messages would pick up as its own. */
  private async isTaken(id: string, length: number): Promise<boolean> {
    if ((await this.store.load(id)) !== undefined) return true;
    if (!this.checkpointStore) return false;
    // a turn counter means `id` ran turns even where no turn-<length> checkpoint survives.
    return Boolean((await this.checkpointStore.load(`${id}.turn-${length}`)) || (await this.checkpointStore.load(turnCounterKey(id)).catch(ignoreCorrupt)));
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
      // Every approval of the paused step continues this session.
      for (const approvalId of pausedApprovalIds(checkpoint)) this.pausedTurnFound(approvalId);
    }
  }

  /**
   * Called when `pending()`, `resume()`, `send()` or `stream()` finds this session's turn waiting on approval
   * `approvalId`, so `agent.approvals.resolve()` continues it in this session.
   */
  protected pausedTurnFound(_approvalId: string): void {}

  private awaitingApproval({ sessionId, approvalId, approvalKind }: Checkpoint): SessionAwaitingApprovalError {
    return new SessionAwaitingApprovalError(sessionId || (this.turnCheckpoint()?.sessionId ?? this.id), approvalId, approvalKind);
  }

  private async assertNoPendingTurn(): Promise<void> {
    const pending = await this.pendingCheckpoint();
    if (!pending) {
      const paused = inMemoryPause(this.store, this.id);
      if (paused) throw new SessionAwaitingApprovalError(this.id, paused.approvalId, paused.approvalKind);
      return;
    }
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
      // Every queued call reads the transcript again, so turns that another session object (or
      // `agent.resume()` / `agent.approvals.resolve()`, which open their own) committed since are not lost on this one.
      this.loaded = false;
      return task();
    });
  }

  /** Reads the transcript from the store, once per queued call (see `enqueue`). */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.transcript = (await this.store.load(this.id)) ?? [];
    if (this.checkpointStore) {
      const counter = await this.checkpointStore.load(turnCounterKey(this.id)).catch(ignoreCorrupt);
      this.turnHighWater = counter?.stepIndex ?? 0;
    }
    this.loaded = true;
  }

  private async turn(call: SessionTurnCall, inputs: InputQueue, signal?: AbortSignal): Promise<ExecutionResult> {
    await this.beforeTurn(signal);
    const input = toMessages(call.input);
    const options = this.turnOptions(inputs);
    await this.holdRunLease(options);
    try {
      return this.record(await this.attempt(() => this.run([...this.transcript, ...input], signal, options, call), { input, call }), input);
    } finally {
      await this.releaseRunLease();
    }
  }

  /**
   * Runs a turn's `run`; when it throws in a checkpointed session, the turn's checkpoint records the
   * error (`lastError`) and the failed attempts (`attempts`), so a turn that failed for good is not replayed by
   * every later `send()` (see `resumePending`).
   */
  private async attempt(run: () => Promise<ExecutionResult>, turn?: FailedTurnInput): Promise<ExecutionResult> {
    try {
      return await run();
    } catch (error) {
      await this.recordFailure(error, turn).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Runs again a turn whose first model call failed before the run saved a checkpoint (`Checkpoint.unstarted`):
   * a new run from its input (`REPLACES_CHECKPOINT`, so the agent's system prompt is added as on any new turn), with
   * the metadata and principal it was sent with. Its first checkpoint replaces the one `recordFailure` wrote.
   */
  private rerunUnstarted(pending: Checkpoint, signal: AbortSignal | undefined, options: SessionTurnOptions | undefined): Promise<ExecutionResult> {
    if (options) (options as SessionTurnOptions & RunLeaseOptions)[REPLACES_CHECKPOINT] = true;
    const input = pending.messages.slice(this.transcript.length);
    return this.run([...pending.messages], signal, options, { input, metadata: pending.metadata, principal: pending.principal });
  }

  /**
   * Takes the turn's run lease before the run starts and hands it to the
   * run (`HELD_RUN_LEASE`, so the executor saves under it instead of taking its
   * own). The session keeps it until `record()` is done, so `recordFailure()`
   * can write through `RunLease.save` - fenced: a run that lost its lease (it
   * stalled past it and another process took the turn over) cannot stamp its
   * failure on the checkpoint the new holder owns.
   */
  private async holdRunLease(options: SessionTurnOptions | undefined): Promise<void> {
    const { sessionId, checkpointStore } = options ?? {};
    if (!sessionId || !checkpointStore) return;
    const lease = await acquireRunLease(checkpointStore, sessionId);
    if (!lease) return;
    this.turnLease = lease;
    (options as SessionTurnOptions & RunLeaseOptions)[HELD_RUN_LEASE] = lease;
  }

  /** Releases the lease `holdRunLease` took; the turn's own `releaseLease` leaves another holder's alone. */
  private async releaseRunLease(): Promise<void> {
    const lease = this.turnLease;
    this.turnLease = undefined;
    await lease?.release().catch(() => undefined);
  }

  private async recordFailure(error: unknown, input?: FailedTurnInput): Promise<void> {
    // A turn refused because another process runs it (its run lease) did not run: the checkpoint is that process's.
    if (error instanceof SDKError && error.code === 'LOUSHO_SESSION_BUSY') return;
    const turn = this.turnCheckpoint();
    const checkpoint = turn && ((await turn.checkpointStore.load(turn.sessionId)) ?? this.unstartedTurn(turn.sessionId, error, input));
    if (!turn || !checkpoint || (checkpoint.status ?? 'in-progress') !== 'in-progress') return;
    const failed = { ...checkpoint, lastError: checkpointError(error), attempts: (checkpoint.attempts ?? 0) + 1 };
    // Under the turn's own lease the write is fenced - it throws LOUSHO_SESSION_BUSY, writing
    // nothing, when the run lost the lease and the checkpoint now belongs to the run that took it over.
    if (this.turnLease?.id === turn.sessionId) {
      await this.turnLease.save(failed);
      return;
    }
    await turn.checkpointStore.save(turn.sessionId, failed);
  }

  /**
   * The checkpoint a new turn whose first model call failed is kept in, before the run saved one (the run saves its
   * first after a model response): the transcript plus the turn's input, so the next `send()` / `resume()` runs it
   * again (see `rerunUnstarted`) instead of losing the message. Only for a provider failure: an error such as a bad
   * configuration fails the call and leaves nothing to resume, as before.
   */
  private unstartedTurn(sessionId: string, error: unknown, turn: FailedTurnInput | undefined): Checkpoint | null {
    if (!turn || turn.input.length === 0 || !(error instanceof LLMProviderError)) return null;
    const { metadata, principal } = turn.call;
    return {
      agentId: '',
      sessionId,
      stepIndex: 0,
      messages: [...this.transcript, ...turn.input],
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      status: 'in-progress',
      unstarted: true,
      ...(metadata !== undefined && { metadata }),
      ...(principal && { principal }),
    };
  }

  /**
   * Runs `task` as the next turn, whose run takes queued input from `inputs`.
   * Under `turnPolicy: 'queue'` (or `'steer'`), while a
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

  /**
   * Where the next turn is checkpointed. `n` starts at the transcript length
   * (so sessions checkpointed by earlier releases are found again) and only
   * grows: {@link turnHighWater} survives a `compact()`'s shorter transcript
   * and is persisted in the {@link turnCounterKey} checkpoint.
   */
  private turnCheckpoint(): SessionTurnCheckpoint | undefined {
    const { checkpointStore } = this;
    if (!checkpointStore) return undefined;
    this.turnIndex ??= Math.max(this.turnHighWater ?? 0, this.transcript.length);
    return { sessionId: `${this.id}.turn-${this.turnIndex}`, checkpointStore };
  }

  /** The next turn's checkpoint and, with `limits`, the session's budget; starts the turn's clock. */
  private turnOptions(inputQueue?: InputQueue): SessionTurnOptions | undefined {
    this.turnStartedAt = Date.now();
    const checkpoint = { ...this.turnCheckpoint(), ...(inputQueue && { inputQueue }), permissionMode: this.currentPermissionMode, ...(this.turnEvents && { onAgentEvent: this.turnEvents }) };
    if (!this.limits) return checkpoint;
    return { ...checkpoint, sessionBudget: { limits: this.limits, spent: sessionSpent(this.transcript) } };
  }

  /**
   * Deletes the checkpoint and checkpoint history of every turn of the session, `<id>.turn-<n>`. A turn's
   * `n` is the transcript length when it started, so `n` runs up to the transcript's length - or further, when a
   * compaction shortened it: every checkpoint found holds the transcript of its turn, whose length is a later turn's `n`.
   */
  private async deleteTurnCheckpoints(): Promise<void> {
    const { checkpointStore } = this;
    if (!checkpointStore) return;
    // turn numbers run past the transcript length once a compaction shortened it.
    let last = Math.max(this.transcript.length, this.turnHighWater ?? 0);
    for (let n = 0; n <= last; n++) {
      const id = `${this.id}.turn-${n}`;
      // Only the newest history entry: it holds the turn's longest transcript (reading whole rings made clear() quadratic).
      const saved = [await checkpointStore.load(id).catch(ignoreCorrupt), ...((await getCheckpointHistory(checkpointStore, id, { limit: 1 })) ?? []).map((entry) => entry.checkpoint)];
      for (const checkpoint of saved) if (checkpoint) last = Math.max(last, checkpoint.messages.length);
      await checkpointStore.delete(id);
    }
    await checkpointStore.delete(turnCounterKey(this.id));
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
    // A turn waiting on an approval counts whatever transcript it started from.
    if (!checkpoint) return pausedSessionTurn(turn.checkpointStore, this.id);
    if (checkpoint.status !== 'finished') return checkpoint;
    await this.commit(checkpoint.messages, runSpent(restoreRunUsage(checkpoint.usage), checkpoint.stepIndex, 0));
    return null;
  }

  /** `retryFailed` (an explicit `resume()`): run a turn again whose last attempt failed with an error retrying cannot fix. */
  private async resumePending(signal?: AbortSignal, retryFailed = false): Promise<ExecutionResult | null> {
    const pending = await this.pendingCheckpoint();
    if (!pending) {
      // a pause without a checkpoint store is an in-memory marker.
      const paused = inMemoryPause(this.store, this.id);
      if (!paused) return null;
      for (const approvalId of pauseApprovalIds(paused)) this.pausedTurnFound(approvalId);
      throw new SessionAwaitingApprovalError(this.id, paused.approvalId, paused.approvalKind);
    }
    if (pending.status === 'awaiting-approval') {
      this.foundPaused(pending);
      throw this.awaitingApproval(pending);
    }
    const failed = pending.lastError;
    if (failed && !failed.retryable && !retryFailed) {
      throw new SDKError(
        `Session '${this.id}' has a turn that failed ${pending.attempts ?? 1} time(s) with an error retrying cannot fix ` +
          `(${failed.code ? `${failed.code}: ` : ''}${failed.message}). Call session.discardPending() to drop that turn and send again, ` +
          'or session.resume() to try it once more after fixing the cause.',
        'LOUSHO_SESSION_TURN_FAILED'
      );
    }
    const options = this.turnOptions();
    await this.holdRunLease(options);
    try {
      if (pending.unstarted) return this.record(await this.attempt(() => this.rerunUnstarted(pending, signal, options)));
      return this.record(await this.attempt(() => this.run([], signal, options)));
    } finally {
      await this.releaseRunLease();
    }
  }

  /**
   * Runs `next` as this session's next turn (after any queued `send()`) and
   * records the transcript it returns. `createAgent()` uses it to continue a
   * session whose turn paused for approval.
   */
  protected continueTurn(next: () => Promise<ExecutionResult>): Promise<ExecutionResult> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      this.turnStartedAt = Date.now();
      try {
        return await this.record(await next());
      } catch (error) {
        // A continuation that fails before record() leaves the pause dead (its
        // approval is consumed) — drop the in-memory marker rather than refuse
        // every later send() forever.
        markInMemoryPause(this.store, this.id, undefined);
        throw error;
      }
    });
  }

  /**
   * Points {@link pausedTurnKey} at this turn's checkpoint while it waits on an approval, so a new turn
   * under the session's id - `agent.send(msg, { sessionId })`, or a session object over another transcript - is
   * refused with `SessionAwaitingApprovalError` instead of running beside the paused one.
   */
  private async markPaused(): Promise<void> {
    const turn = this.turnCheckpoint();
    const checkpoint = turn && (await turn.checkpointStore.load(turn.sessionId));
    if (!turn || checkpoint?.status !== 'awaiting-approval') return;
    await turn.checkpointStore.save(pausedTurnKey(this.id), { ...checkpoint, messages: [], toolCalls: [], stepUsage: undefined, businessState: undefined });
  }

  /** `input`: the turn's new user message(s), kept when the turn is aborted. */
  private async record(result: ExecutionResult, input: readonly Message[] = []): Promise<ExecutionResult> {
    if (result.finishReason === 'aborted') {
      const kept = abortedTurn(result, this.transcript, input);
      if (kept) await this.commit(kept, runSpent(result.usage, result.steps, Date.now() - this.turnStartedAt));
      markInMemoryPause(this.store, this.id, undefined);
      await this.deleteCheckpoint();
      return result;
    }
    // A checkpointed turn joins the transcript once, when it finishes; until then its checkpoint holds it.
    if (result.finishReason === 'awaiting-approval') {
      // Its spend is recorded once the turn finishes (the resumed result counts it all).
      if (!this.checkpointStore) {
        // without a checkpoint there is no durable pause marker;
        // keep one in-process so the next send()/compact() is refused instead
        // of committing a turn the resume would silently overwrite.
        markInMemoryPause(this.store, this.id, { approvalId: result.approvalId, approvalIds: result.approvalIds });
        await this.commit(result.messages);
      } else await this.markPaused();
    } else {
      markInMemoryPause(this.store, this.id, undefined);
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
   * this turn included.
   */
  private async commit(messages: readonly Message[], spent?: BudgetSpent): Promise<void> {
    const withoutSystem = messages[0]?.role === 'system' ? messages.slice(1) : messages;
    const next = providerValidPrefix(withoutSystem);
    const last = next.at(-1);
    if (this.limits && spent && last) {
      const sessionUsage = addSpent(sessionSpent(this.transcript), spent);
      next[next.length - 1] = { ...last, metadata: { ...last.metadata, sessionUsage } };
    }
    if (!(await this.saveOver(this.transcript, next))) return this.busy(next);
    const turn = this.turnCheckpoint();
    const start = this.transcript.length;
    this.transcript = next;
    if (turn) {
      // the claimed `n` is spent; the high-water (and the transcript
      // length, so numbers stay aligned while it grows) may not be reused.
      this.turnHighWater = Math.max(this.turnHighWater ?? 0, (this.turnIndex ?? 0) + 1, next.length);
      this.turnIndex = undefined;
      await turn.checkpointStore.delete(turn.sessionId, { keepHistory: this.turnHistoryLimit > 0 });
      await turn.checkpointStore.save(turnCounterKey(this.id), turnCounterCheckpoint(this.id, this.turnHighWater));
      await this.dropOldTurnHistory(next, start);
    }
  }

  /**
   * Keeps the checkpoint history of only the last `turnHistoryLimit` committed
   * turns (each holds copies of the whole transcript, so keeping every turn's
   * grew the store quadratically). A turn's checkpoint id is `<id>.turn-<n>`,
   * `n` being where its user message starts in the transcript, so the turns
   * outside the window are found from the user messages before `start`, the
   * turn just committed. Every commit deletes the newest of them (the turn that
   * just left the window), so the window holds even when each turn uses a new
   * store object or process. Older ones (history left by an earlier release, or
   * by a larger limit) are deleted oldest first, at most
   * {@link DROPPED_TURNS_PER_COMMIT} per commit, from where earlier commits of
   * this process got to.
   */
  private async dropOldTurnHistory(transcript: readonly Message[], start: number): Promise<void> {
    const { checkpointStore } = this;
    if (!checkpointStore) return;
    const starts: number[] = [];
    for (let i = 0; i < start && i < transcript.length; i++) if (transcript[i].role === 'user') starts.push(i);
    // A turn can hold more than one user message (queued input): every one of them outside the window is a candidate.
    const outside = starts.slice(0, Math.max(0, starts.length - Math.max(0, this.turnHistoryLimit - 1)));
    const left = outside.slice(-LEFT_WINDOW_PER_COMMIT);
    for (const n of left) await checkpointStore.delete(`${this.id}.turn-${n}`);
    const backlogEnd = left[0] ?? 0;
    let cursors = droppedTurnHistory.get(checkpointStore);
    if (!cursors) droppedTurnHistory.set(checkpointStore, (cursors = new Map()));
    const known = cursors.get(this.id) ?? 0;
    // A compaction (or clear()) shortened the transcript: start over.
    const below = known > transcript.length ? 0 : known;
    const backlog = outside.filter((n) => n >= below && n < backlogEnd);
    const batch = backlog.slice(0, DROPPED_TURNS_PER_COMMIT);
    for (const n of batch) await checkpointStore.delete(`${this.id}.turn-${n}`);
    if (outside.length > 0) cursors.set(this.id, backlog.length > batch.length ? backlog[batch.length] : outside[outside.length - 1] + 1);
  }

  /**
   * Saves `next` only if the store still holds `base`. With the store's `saveIf` that is one atomic
   * compare-and-swap; without it, a load, compare and save, which a writer in another process can slip between.
   */
  private async saveOver(base: readonly Message[], next: readonly Message[]): Promise<boolean> {
    if (this.store.saveIf) return this.store.saveIf(this.id, transcriptRevision(base), next);
    if (!sameTranscript((await this.store.load(this.id)) ?? [], base)) return false;
    await this.store.save(this.id, next);
    return true;
  }

  /**
   * Optimistic concurrency for turns that CANNOT share this process's queue:
   * a second `SessionStore` object over the same transcript (another process,
   * or `fileStore(dir)` built twice). When the store no longer holds the
   * transcript this turn started from (`saveOver` failed), committing would overwrite the other
   * writer's turn without an error - instead the turn's leftover checkpoint
   * is dropped (replaying it later would clobber the committed transcript
   * anyway) and the send fails with `LOUSHO_SESSION_BUSY`. Tool calls of the
   * turn that ran (an email, a refund) are not lost: the turn up
   * to their results is added after the other writer's transcript, as an
   * aborted turn keeps them.
   */
  private async busy(next: readonly Message[]): Promise<void> {
    const stored = (await this.store.load(this.id)) ?? [];
    const base = this.transcript;
    const turn = this.turnCheckpoint();
    // The other writer committed this very turn (it adopted the finished checkpoint first): nothing is lost or duplicated.
    if (stored.length >= next.length && sameTranscript(stored.slice(0, next.length), next)) {
      this.transcript = stored;
      if (turn) await turn.checkpointStore.delete(turn.sessionId, { keepHistory: true });
      return;
    }
    if (turn) await turn.checkpointStore.delete(turn.sessionId, { keepHistory: true });
    const ran = sameTranscript(next.slice(0, base.length), base) ? completedToolPrefix(next, base) : undefined;
    const kept = ran && [...stored, ...ran.slice(base.length)];
    const keptRan = kept !== undefined && (await this.saveOver(stored, kept));
    if (keptRan) this.transcript = kept;
    throw new SDKError(
      `Session '${this.id}' was changed by another session object or process while this turn ran; ` +
        (keptRan ? "the turn was not committed, except its tool calls that ran, which were added after the other writer's turn. " : 'the turn was not committed. ') +
        'Reload the transcript and send again.',
      'LOUSHO_SESSION_BUSY'
    );
  }
}
