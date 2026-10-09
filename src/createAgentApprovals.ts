/**
 * Approvals for createAgent() agents (LOU-D21): a thin layer over an
 * ApprovalStore and resumeAfterApproval(). It records which approvals the
 * agent paused on (for `agent.approvals.list()`), continues a paused session
 * when its approval is resolved, and - with an `approve` callback - decides
 * each pause at once by resuming the run with the callback's answer.
 */

import { approvalExpired, describeApproval, type ApprovalDecision, type ApprovalStore, type PendingApproval } from './execution/ApprovalGate';
import type { ExecutionResult } from './execution/AgentExecutor';
import type { AgentEvent } from './execution/agentEvents';
import type { AgentRun } from './execution/agentRun';
import type { CheckpointStore } from './execution/checkpoint';
import { SDKError, SessionAwaitingApprovalError } from './execution/errors';
import type { InputQueue } from './execution/inputQueue';
import { streamSessionTurn } from './session/sessionStream';
import { AgentSession, type PendingTurn, type SessionOptions, type SessionRunner, type SessionSpawner, type SessionStreamRunner } from './session/AgentSession';
import type { PermissionOptions } from './execution/permissions';
import type { Principal } from './auth/types';

/** N4: the mode a continued run uses: the paused session's (a getter), or undefined for the agent's. */
type ResumeMode = PermissionOptions['permissionMode'];

/**
 * Options of `agent.approvals.resolve()` / `answer()` / `streamResolve()` /
 * `streamAnswer()`.
 */
export interface ResolveApprovalOptions {
  signal?: AbortSignal;
  /**
   * N10b: who decides (route auth's principal, a channel's clicking user).
   * The approved tool sees it as `ctx.approval.by`; the run itself goes on
   * as the principal it paused with, never as this one (docs/auth.md).
   */
  principal?: Principal;
}

/**
 * Decides a tool call that needs approval without pausing the run: `true`
 * runs the tool, `false` gives the model a rejection as the tool's result.
 * A string approves with that string as the note - for an `ask_question`
 * call (`request.kind === 'question'`), it is the answer (LOU-X9). It is
 * never asked about a sign-in (`kind: 'sign-in'`, N9b): only the user can sign in.
 * `request.principal` (N10b) is who the paused run acts for.
 *
 * The literal `'defer'` does not decide: the call stays pending (listed by
 * `agent.approvals.list()`, resolvable by `agent.approvals.resolve()`) and
 * the run surfaces the pause - `send()` resolves with
 * `finishReason: 'awaiting-approval'`, exactly as if the callback had never
 * been asked. An approver can thereby decide the calls it trusts and hand
 * the rest to a human. (`'defer'` is reserved: a note that is exactly the
 * string `'defer'` defers instead of approving.)
 *
 * @example
 * ```ts
 * const approve: ApproveToolCall = ({ toolName, args }) => toolName !== 'send_email' || args.to === 'me@example.com';
 * const answer: ApproveToolCall = (request) => (request.kind === 'question' ? 'Lisbon' : true);
 * const triage: ApproveToolCall = ({ toolName }) => (toolName === 'lookup' ? true : 'defer'); // humans decide the rest
 * ```
 */
export type ApproveToolCall = (request: PendingApproval) => boolean | 'defer' | (string & {}) | Promise<boolean | 'defer' | (string & {})>;

/** `agent.approvals`: the tool calls a `createAgent()` agent is paused on, and how to decide them. */
export interface AgentApprovals {
  /**
   * Approvals this agent paused on in this process and that are not decided
   * yet, oldest first. TTL: an entry past its `expiresAt` stays listed until
   * decided - the run is still paused - but deciding it denies the call.
   */
  list(): Promise<PendingApproval[]>;
  /**
   * The pending approval `id`, without deciding it: this process's pauses
   * first, then - through an `approvalStore` that implements `load` - a pause
   * saved before a restart (the request's facts as it was recorded, so a
   * channel's function `approvers` sees the same input then as now, #280).
   * `undefined` when `id` is unknown or already resolved.
   */
  get(id: string): Promise<PendingApproval | undefined>;
  /**
   * Approves or rejects a paused tool call (`note` is passed to the model
   * with a rejection) and continues the run, resolving with the continued
   * run's result - which may pause again. A run paused inside
   * `agent.session()` continues in that session. Throws when `id` is unknown
   * or already resolved. TTL: a pause past its `expiresAt` is denied
   * ('approval expired') even when `approved: true` is passed - an expired
   * approval never runs its tool.
   *
   * @example
   * ```ts
   * const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
   * ```
   */
  resolve(decision: ApprovalDecision, options?: ResolveApprovalOptions): Promise<ExecutionResult>;
  /**
   * Answers a paused `ask_question` call (LOU-X9): the same as
   * `resolve({ id, approved: true, note: answer })`. The model gets
   * `{ answer, option? }` as the tool's result.
   *
   * @example
   * ```ts
   * const result = await agent.approvals.answer({ id: paused.approvalId!, answer: 'Lisbon' });
   * ```
   */
  answer(reply: { id: string; answer: string }, options?: ResolveApprovalOptions): Promise<ExecutionResult>;
  /**
   * LOU-V14: like `resolve()`, but streams the continued run as the
   * `AgentRun` that `agent.stream()` returns (see docs/streaming.md). Its
   * `result` is what `resolve()` resolves with, except that, like
   * `stream()`, it ends at the next pause even with an `approve` callback.
   *
   * @example
   * ```ts
   * for await (const event of agent.approvals.streamResolve({ id: paused.approvalId!, approved: true })) {
   *   if (event.type === 'text.delta') process.stdout.write(event.text);
   * }
   * ```
   */
  streamResolve(decision: ApprovalDecision, options?: ResolveApprovalOptions): AgentRun;
  /** LOU-V14: `answer()`, streamed like `streamResolve()`. */
  streamAnswer(reply: { id: string; answer: string }, options?: ResolveApprovalOptions): AgentRun;
}

/**
 * resumeAfterApproval() bound to an agent's registry, provider and options;
 * `checkpointStore` is the paused session's, when its turns are checkpointed,
 * `permissionMode` (N4) the session's mode and `approver` (N10b) who decided.
 */
type ResumeRun = (
  store: ApprovalStore,
  decision: ApprovalDecision,
  signal?: AbortSignal,
  checkpointStore?: CheckpointStore,
  permissionMode?: ResumeMode,
  approver?: Principal,
  /** LOU-R18: the paused session's on() forwarder, when the run continues in one. */
  onAgentEvent?: (event: AgentEvent) => void
) => Promise<ExecutionResult>;

/** {@link ResumeRun}, streamed (LOU-V14); `inputQueue` is what `run.enqueue()` pushes to. */
type StreamResumeRun = (
  store: ApprovalStore,
  decision: ApprovalDecision,
  signal?: AbortSignal,
  checkpointStore?: CheckpointStore,
  inputQueue?: InputQueue,
  permissionMode?: ResumeMode,
  approver?: Principal,
  /** LOU-R18: the paused session's on() forwarder, when the run continues in one. */
  onAgentEvent?: (event: AgentEvent) => void
) => AgentRun;

/** A session whose paused turn can be continued by `agent.approvals.resolve()`. */
class ApprovalSession extends AgentSession {
  /** Set by createAgentApprovals(): binds an approval id to this session. */
  binds?: (approvalId: string) => void;

  /**
   * coding-agent F2: finding a paused turn binds it - the natural
   * "check pending(), then resolve()" flow then continues in this session
   * instead of falling back to a session-less resume.
   */
  override async pending(): Promise<PendingTurn | null> {
    const turn = await super.pending();
    if (turn?.status === 'awaiting-approval' && turn.approvalId) this.binds?.(turn.approvalId);
    return turn;
  }

  /**
   * Eve DUR-F6: a checkpointed session turn paused at `pausedAt`
   * (`<id>.turn-<n>`) can only be continued while its checkpoint exists - it
   * holds the turn until it finishes. When it is gone (pruned, deleted) the
   * resume would run the approved tool and then have nothing to commit to, so
   * fail first, before the tool runs.
   */
  async assertTurnKept(approvalId: string, pausedAt: string | undefined): Promise<void> {
    const { checkpointStore } = this;
    if (!checkpointStore || !pausedAt?.startsWith(`${this.id}.turn-`)) return;
    if (await checkpointStore.load(pausedAt)) return;
    throw new SDKError(
      `Approval '${approvalId}' belongs to session '${this.id}', but its paused turn ('${pausedAt}') is no longer stored ` +
        '(pruned or deleted), so it cannot be continued and the tool was not run.',
      'LOUSHO_APPROVAL_ORPHANED'
    );
  }

  resolveWith(
    next: (checkpointStore?: CheckpointStore, permissionMode?: ResumeMode, onAgentEvent?: (event: AgentEvent) => void) => Promise<ExecutionResult>,
    before?: () => Promise<void>
  ): Promise<ExecutionResult> {
    return this.continueTurn(async () => {
      await before?.();
      return next(this.checkpointStore, this.currentPermissionMode, this.turnEvents);
    });
  }

  /** LOU-V14: `resolveWith()`, streamed: `run.done` comes once the session has recorded the turn. */
  streamResolveWith(
    next: (
      checkpointStore: CheckpointStore | undefined,
      signal: AbortSignal,
      inputs: InputQueue,
      permissionMode: ResumeMode,
      onAgentEvent?: (event: AgentEvent) => void
    ) => AgentRun,
    signal?: AbortSignal,
    before?: () => Promise<void>
  ): AgentRun {
    return streamSessionTurn(
      (runSignal, started, inputs) =>
        this.continueTurn(async () => {
          await before?.();
          const run = next(this.checkpointStore, runSignal, inputs, this.currentPermissionMode, this.turnEvents);
          started(run);
          return run.result;
        }),
      signal
    );
  }
}

/** Wires an agent's approval store, `approve` callback and resume function together. */
export function createAgentApprovals(options: {
  store: ApprovalStore;
  approve?: ApproveToolCall;
  resume: ResumeRun;
  streamResume: StreamResumeRun;
  /**
   * The agent's checkpoint store, when it has one (LOU-D30). Used to tell a
   * paused *session turn* apart from a `send(msg, { sessionId })` run when
   * `resolve()` must rebind a session it never saw (see `coldSession`).
   */
  checkpoints?: CheckpointStore;
  /**
   * Opens the agent's session `id` (a fresh `agent.session({ id })`). Lets
   * `resolve()`/`streamResolve()` continue a paused session turn inside its
   * session even when that session was never opened in this process - without
   * it such a resolve ran outside the session and the turn was never recorded.
   */
  openSession?: (id: string) => AgentSession;
}) {
  const { approve, resume, streamResume } = options;
  const pending = new Map<string, PendingApproval>();
  const sessions = new Map<string, ApprovalSession>();
  /**
   * Session factory captured from `session()` calls (its `spawn` argument is
   * the agent's session factory): the fallback opener when `openSession` was
   * not wired - it only exists once this process opened a session itself.
   */
  let sessionSpawner: SessionSpawner | undefined;
  // A1: the session each pause belongs to, kept until the pause is claimed (unlike `sessions`, which a decision clears first).
  const sessionIds = new Map<string, string>();
  const bind = (id: string, session: ApprovalSession) => {
    sessions.set(id, session);
    sessionIds.set(id, session.id);
  };
  const withSession = (request: PendingApproval): PendingApproval => {
    const sessionId = sessionIds.get(request.id);
    return sessionId === undefined ? request : { ...request, sessionId };
  };
  const store: ApprovalStore = {
    async save(raw, snapshot) {
      // LOU-X9: an `ask_question` call is recorded as `kind: 'question'`.
      const request = describeApproval(raw);
      await options.store.save(request, snapshot);
      pending.set(request.id, request);
    },
    async resolve(id) {
      const record = await options.store.resolve(id);
      pending.delete(id);
      sessionIds.delete(id);
      return record;
    },
  };

  /**
   * The `approve` callback's verdict on `request`, or `false` once its
   * `expiresAt` (TTL) passes - an expired pause resumes as a denial
   * (`approval expired`), never with a stale approval, whatever the callback
   * answers later.
   */
  async function decide(request: PendingApproval): Promise<boolean | string> {
    if (!approve) return false;
    const expiresAt = request.expiresAt === undefined ? undefined : Date.parse(request.expiresAt);
    if (expiresAt === undefined || Number.isNaN(expiresAt)) return approve(request);
    if (approvalExpired(request)) return false;
    const left = expiresAt - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        approve(request),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), left);
          // The deadline alone must not keep the process alive.
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** With an `approve` callback, decides every pause until the run finishes. */
  async function settle(
    result: ExecutionResult,
    signal?: AbortSignal,
    checkpointStore?: CheckpointStore,
    permissionMode?: ResumeMode,
    onAgentEvent?: (event: AgentEvent) => void
  ): Promise<ExecutionResult> {
    let current = result;
    for (;;) {
      const request = current.approvalId ? pending.get(current.approvalId) : undefined;
      // N9b: only the user can sign in, so a sign-in pause is never decided by `approve`.
      if (!approve || current.finishReason !== 'awaiting-approval' || !request || request.kind === 'sign-in') return current;
      const verdict = await decide(request);
      // A 'defer' verdict is not a decision: the approval stays pending and
      // the paused result is surfaced as it is, for the human path to resolve.
      if (verdict === 'defer') return current;
      const decision = typeof verdict === 'string' ? { id: request.id, approved: true, note: verdict } : { id: request.id, approved: verdict };
      current = await resume(store, decision, signal, checkpointStore, permissionMode, undefined, onAgentEvent);
    }
  }

  function inSession(session: ApprovalSession | undefined, result: ExecutionResult): ExecutionResult {
    if (session && result.finishReason === 'awaiting-approval' && result.approvalId) {
      bind(result.approvalId, session);
    }
    return result;
  }

  /** `run`, with a pause it reports (as an event or in its result) bound to `session`. */
  function inSessionRun(session: ApprovalSession, run: AgentRun): AgentRun {
    return {
      runId: run.runId,
      result: run.result.then((result) => inSession(session, result)),
      enqueue: (input) => run.enqueue(input),
      steer: (input) => run.steer(input),
      async *[Symbol.asyncIterator]() {
        for await (const event of run) {
          if (event.type === 'approval.requested') bind(event.approvalId, session);
          yield event;
        }
      },
    };
  }

  /** N9b: a sign-in pause approved too early stays paused, and stays bound to its session. */
  function keepPendingSession(id: string, session: ApprovalSession | undefined, error: unknown): void {
    if (session && error instanceof Error && error.name === 'SignInPendingError') bind(id, session);
  }

  /**
   * The session a paused run belongs to, for a `resolve()`/`streamResolve()`
   * made after a restart (or by a caller that never opened the session): the
   * `sessions` map only knows pauses this process made or ran into. Without
   * this, the resume ran outside the session - the 'finished' checkpoint it
   * left behind was never committed to the transcript, which read as if the
   * whole turn had been deleted (coding-agent F1).
   *
   * The pause record's `snapshot.sessionId` is read WITHOUT claiming it:
   * `<id>.turn-<n>` means a durable session turn (the session's id is `<id>`);
   * a bare `<id>` with no checkpoint under it is a session turn that ran
   * without checkpointing (a `send(msg, { sessionId })` run of the same id
   * would have left its own checkpoint). Returns `undefined` - falling back
   * to the old session-less resume - when no opener exists or the pause was
   * not a session turn.
   */
  async function coldSession(approvalId: string): Promise<ApprovalSession | undefined> {
    const spawn = sessionSpawner;
    const open = options.openSession ?? (spawn && ((id: string) => spawn({ id })));
    if (!open || !options.store.load) return undefined;
    const record = await options.store.load(approvalId);
    const pausedAt = record?.snapshot.sessionId;
    if (!pausedAt) return undefined;
    const turn = /^([A-Za-z0-9_-]{1,128})\.turn-\d+$/.exec(pausedAt);
    let sessionId: string | undefined;
    if (turn) {
      sessionId = turn[1];
    } else if (options.checkpoints && (await options.checkpoints.load(pausedAt)) === null) {
      sessionId = pausedAt;
    }
    if (!sessionId) return undefined;
    const opened = open(sessionId);
    return opened instanceof ApprovalSession ? opened : undefined;
  }

  /** Eve DUR-F6: fails with `LOUSHO_APPROVAL_ORPHANED` when the session turn the pause belongs to is gone. */
  async function turnKept(approvalId: string, session: ApprovalSession): Promise<void> {
    const record = await options.store.load?.(approvalId);
    await session.assertTurnKept(approvalId, record?.snapshot.sessionId);
  }

  // N10b: `principal` is the approver of this decision only; the `approve` callback's later decisions have none.
  function resolve(decision: ApprovalDecision, { signal, principal }: ResolveApprovalOptions = {}): Promise<ExecutionResult> {
    let session = sessions.get(decision.id);
    sessions.delete(decision.id);
    const resolved = (async () => {
      session ??= await coldSession(decision.id);
      const next = async (checkpointStore?: CheckpointStore, permissionMode?: ResumeMode, onAgentEvent?: (event: AgentEvent) => void) =>
        inSession(
          session,
          await settle(await resume(store, decision, signal, checkpointStore, permissionMode, principal, onAgentEvent), signal, checkpointStore, permissionMode, onAgentEvent)
        );
      const kept = session;
      return kept ? kept.resolveWith(next, () => turnKept(decision.id, kept)) : next();
    })();
    return resolved.catch((error: unknown) => {
      keepPendingSession(decision.id, session, error);
      throw error;
    });
  }

  function streamResolve(decision: ApprovalDecision, { signal, principal }: ResolveApprovalOptions = {}): AgentRun {
    const bound = sessions.get(decision.id);
    sessions.delete(decision.id);
    if (!bound) {
      // The pause may belong to a session this process never opened: find it
      // before the resumed run starts (resolve() does the same lookup).
      return streamSessionTurn(async (runSignal, started, inputs) => {
        const session = await coldSession(decision.id);
        if (session) {
          const run = session.streamResolveWith(
            (checkpointStore, innerSignal, _innerInputs, permissionMode, onAgentEvent) =>
              inSessionRun(session, streamResume(store, decision, innerSignal, checkpointStore, inputs, permissionMode, principal, onAgentEvent)),
            runSignal,
            () => turnKept(decision.id, session)
          );
          started(run);
          run.result.catch((error: unknown) => keepPendingSession(decision.id, session, error));
          return run.result;
        }
        const run = streamResume(store, decision, runSignal, undefined, inputs, undefined, principal);
        started(run);
        return run.result;
      }, signal);
    }
    const run = bound.streamResolveWith(
      (checkpointStore, runSignal, inputs, permissionMode, onAgentEvent) =>
        inSessionRun(bound, streamResume(store, decision, runSignal, checkpointStore, inputs, permissionMode, principal, onAgentEvent)),
      signal,
      () => turnKept(decision.id, bound)
    );
    run.result.catch((error: unknown) => keepPendingSession(decision.id, bound, error));
    return run;
  }

  const approvals: AgentApprovals = {
    list: async () => [...pending.values()].map(withSession),
    // #280: the durable store answers too, so a pause this process did not make is found again.
    get: async (id) => {
      const found = pending.get(id) ?? (await options.store.load?.(id))?.pending;
      return found === undefined ? undefined : withSession(describeApproval(found));
    },
    resolve,
    answer: ({ id, answer }, resolveOptions) => resolve({ id, approved: true, note: answer }, resolveOptions),
    streamResolve,
    streamAnswer: ({ id, answer }, resolveOptions) => streamResolve({ id, approved: true, note: answer }, resolveOptions),
  };

  return {
    /** The store to run with: the agent's store, recording what is pending. */
    store,
    approvals,
    settle,
    /** A session of the agent; `spawn` creates its forks (N3a), by default another session with the same `run` / `stream`. */
    session(run: SessionRunner, stream: SessionStreamRunner, sessionOptions?: SessionOptions, spawn?: SessionSpawner): AgentSession {
      // `spawn` is the agent's session factory (agentSession passes it): keep
      // one around so a resolve() that never saw the pause can open the
      // session it belongs to (coldSession).
      if (spawn) sessionSpawner ??= spawn;
      const session: ApprovalSession = new ApprovalSession(
        async (input, signal, turn, call) => {
          try {
            return inSession(session, await settle(await run(input, signal, turn, call), signal, turn?.checkpointStore, turn?.permissionMode));
          } catch (error) {
            // A checkpointed turn found paused (e.g. after a restart): resolving it continues this session.
            if (error instanceof SessionAwaitingApprovalError && error.approvalId) bind(error.approvalId, session);
            throw error;
          }
        },
        sessionOptions,
        (input, signal, turn, call) => inSessionRun(session, stream(input, signal, turn, call)),
        spawn ?? ((forkOptions) => this.session(run, stream, forkOptions))
      );
      session.binds = (approvalId) => bind(approvalId, session);
      return session;
    },
  };
}
