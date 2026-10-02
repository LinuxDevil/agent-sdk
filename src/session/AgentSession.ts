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
import type { Checkpoint, CheckpointStore } from '../execution/checkpoint';
import type { ApprovalKind } from '../execution/ApprovalGate';
import { SDKError, SessionAwaitingApprovalError } from '../execution/errors';
import { streamSessionTurn } from './sessionStream';
import { MemorySessionStore, assertSessionId, type SessionStore } from './sessionStore';
import { addSpent, runSpent, sessionSpent, type BudgetSpent, type RunLimits, type SessionBudget } from '../execution/budget';
import { restoreRunUsage } from '../execution/runUsage';
import { AGENT_EVENT_SCHEMA_VERSION, type AgentEvent, type AgentEventPayload } from '../execution/agentEvents';
import { manualCompactionOptions, type AgentCompaction } from '../context/agentCompaction';
import { compactTranscript, type SessionCompactOptions, type SessionCompactResult } from './sessionCompact';
import type { Principal } from '../auth/types';
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
  private mode: SessionOptions['permissionMode'];
  private readonly onPermissionModeChange: SessionOptions['onPermissionModeChange'];
  /** N4: the session's mode at the time of the call; handed to every turn, so a switch applies from the next tool call. */
  protected readonly currentPermissionMode = (): PermissionMode => this.permissionMode;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  /** The turn running (or about to run) and the queue its run takes input from (LOU-V9). */
  private running: { inputs: InputQueue; result: Promise<ExecutionResult> } | undefined;
  private turnStartedAt = 0;
  private history: Message[] = [];
  private loaded = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(run: SessionRunner, options: SessionOptions = {}, streamRun?: SessionStreamRunner) {
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
  }

  /**
   * Snapshot of the transcript so far (no system prompt). For a session
   * continued from a store it is empty until the first `send()` or
   * `load()` has completed.
   */
  get messages(): readonly Message[] {
    return structuredClone(this.history);
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
    await this.enqueue(() => this.ensureLoaded());
    return this.messages;
  }

  /**
   * Send a user message (a string, content parts or a `Message[]`, see
   * `AgentInput`) with the whole conversation so far. Concurrent calls
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
            const run = streamRun([...this.history, ...toMessages(input)], signal, this.turnOptions(inputs), call);
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
      if (await this.pendingCheckpoint()) await this.deleteCheckpoint();
    });
  }

  /**
   * Listens for the events of `compact()` and `clear()` (`compaction.start`,
   * `compaction.done`, `context.cleared`; a turn's own events come from
   * `stream()`). Returns a function that removes the listener.
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
      const before = this.history;
      if (before.length === 0) return { messagesBefore: 0, messagesAfter: 0, tokensBefore: 0, tokensAfter: 0, strategy: 'none' };
      const { messages, result } = await compactTranscript(structuredClone(before), { ...manualCompactionOptions(this.compaction), ...options }, this.emitter());
      if (JSON.stringify(messages) !== JSON.stringify(before)) {
        await this.store.save(this.id, messages);
        this.history = messages;
      }
      return result;
    });
  }

  /**
   * Empties the transcript (LOU-W8) and saves the empty conversation. The
   * session keeps its id, its store and its options (limits, turn policy);
   * the transcript, an interrupted turn's checkpoint and the spend recorded in
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
      await this.deleteCheckpoint();
      await this.store.delete(this.id);
      const messagesCleared = this.history.length;
      this.history = [];
      // A first turn that finished just before a crash, so was never adopted.
      await this.deleteCheckpoint();
      this.emitter()({ type: 'context.cleared', sessionId: this.id, messagesCleared });
    });
  }

  /** Runs `task` after queued calls, unless a turn is running or queued now (`LOUSHO_SESSION_BUSY`). */
  private idle<T>(task: () => Promise<T>): Promise<T> {
    if (this.running) {
      return Promise.reject(new SDKError(`Session '${this.id}' has a turn in flight; wait for it to finish first.`, 'LOUSHO_SESSION_BUSY'));
    }
    return this.enqueue(task);
  }

  private awaitingApproval({ approvalId, approvalKind }: Checkpoint): SessionAwaitingApprovalError {
    return new SessionAwaitingApprovalError(this.turnCheckpoint()?.sessionId ?? this.id, approvalId, approvalKind);
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

  private async turn(call: SessionTurnCall, inputs: InputQueue, signal?: AbortSignal): Promise<ExecutionResult> {
    await this.beforeTurn(signal);
    return this.record(await this.run([...this.history, ...toMessages(call.input)], signal, this.turnOptions(inputs), call));
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
    return checkpointStore && { sessionId: `${this.id}.turn-${this.history.length}`, checkpointStore };
  }

  /** The next turn's checkpoint and, with `limits`, the session's budget (LOU-V6); starts the turn's clock. */
  private turnOptions(inputQueue?: InputQueue): SessionTurnOptions | undefined {
    this.turnStartedAt = Date.now();
    const checkpoint = { ...this.turnCheckpoint(), ...(inputQueue && { inputQueue }), permissionMode: this.currentPermissionMode };
    if (!this.limits) return checkpoint;
    return { ...checkpoint, sessionBudget: { limits: this.limits, spent: sessionSpent(this.history) } };
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
    await this.commit(checkpoint.messages, runSpent(restoreRunUsage(checkpoint.usage), checkpoint.stepIndex, 0));
    return null;
  }

  private async resumePending(signal?: AbortSignal): Promise<ExecutionResult | null> {
    if (!(await this.pendingCheckpoint())) return null;
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

  private async record(result: ExecutionResult): Promise<ExecutionResult> {
    if (result.finishReason === 'aborted') {
      await this.deleteCheckpoint();
      return result;
    }
    // A checkpointed turn joins the transcript once, when it finishes; until then its checkpoint holds it.
    if (result.finishReason === 'awaiting-approval') {
      // Its spend is recorded once the turn finishes (the resumed result counts it all).
      if (!this.checkpointStore) await this.commit(result.messages);
    } else {
      await this.commit(result.messages, runSpent(result.usage, result.steps, Date.now() - this.turnStartedAt));
    }
    return result;
  }

  /**
   * Saves `messages` (minus the system prompt) as the transcript, then drops
   * the finished turn's checkpoint. With `limits`, the last message records
   * what the session has spent, this turn included (LOU-V6).
   */
  private async commit(messages: readonly Message[], spent?: BudgetSpent): Promise<void> {
    const withoutSystem = messages[0]?.role === 'system' ? messages.slice(1) : messages;
    const next = providerValidPrefix(withoutSystem);
    const last = next.at(-1);
    if (this.limits && spent && last) {
      const sessionUsage = addSpent(sessionSpent(this.history), spent);
      next[next.length - 1] = { ...last, metadata: { ...last.metadata, sessionUsage } };
    }
    await this.store.save(this.id, next);
    const turn = this.turnCheckpoint();
    this.history = next;
    if (turn) await turn.checkpointStore.delete(turn.sessionId);
  }
}
