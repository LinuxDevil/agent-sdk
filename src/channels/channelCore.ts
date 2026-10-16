/**
 * The host-agnostic core of {@link mountChannels} and `mountFetchChannels`:
 * `handle` runs a channel's verify -> parse -> a session turn (or a
 * pause decision) -> reply, answering through `respond`; `resolveApproval`
 * decides a pause a channel turn stopped on. No `node:*` import, so a Worker
 * host can drive the same code (src/channels/fetchChannels.ts).
 */
import { createAgentConfigOf, type SimpleAgent } from '../createAgent';
import type { ExecutionResult } from '../execution/AgentExecutor';
import type { AgentEvent } from '../execution/agentEvents';
import { MemorySessionStore, type SessionStore } from '../session/sessionStore';
import { withDefaultStores, type SessionStores } from '../session/AgentSession';
import {
  approvalPrompt,
  channelSessionId,
  type Channel,
  type ChannelApprovalDecision,
  type ChannelContext,
  type ChannelDecision,
  type ChannelErrorHandler,
  type ChannelInbound,
  type ChannelRequest,
  type ChannelRespond,
  type ChannelUser,
} from './defineChannel';
import { reportChannelError } from './channelSupport';
import type { Principal } from '../auth/types';
import { describeApproval, type ApprovalStore, type PendingApproval, type ResolvedApproval } from '../execution/ApprovalGate';
import { SDKError, SessionAwaitingApprovalError } from '../execution/errors';
import { crossSiteRequest } from '../server/requestGuard';

/** Options of {@link channelCore}: what the hosts' mount options share. */
export interface ChannelCoreOptions {
  /**
   * Where the channels' transcripts are kept (e.g. the `SqliteStore` the agent
   * uses). Defaults to the agent's `store` when it keeps sessions, so channel
   * turns, approval continuations and `agent.resume()` share one transcript;
   * else to an in-memory store owned by this handler.
   */
  store?: SessionStore | SessionStores;
  /** Fallback for a channel without its own `onError`: failures after the request was acknowledged. Default: `console.error`. */
  onError?: ChannelErrorHandler;
  /** Called when a button decision names who decided (the Slack and Discord channels do): the audit trail of approvals. */
  onDecision?(event: { decision: ChannelApprovalDecision; approver: NonNullable<ChannelDecision['approver']>; sessionId: string; channel: string }): void | Promise<void>;
}

/** What a host's mount returns: the channel logic, request/response plumbing left to the host. */
export interface ChannelCore {
  /**
   * Runs `channel`'s verify -> parse -> turn (or a decision on `approvalId`),
   * answering through `respond`. Throws before the surface was acknowledged;
   * failures after that are reported to `onError` (and a failure text replied).
   */
  handle(channel: Channel, approvalId: string | undefined, req: ChannelRequest, respond: ChannelRespond): Promise<void>;
  /**
   * Decides a pause a channel turn stopped on (e.g. from a surface's button
   * callback) and delivers the continuation through the same channel's
   * `reply` (or `onApproval`, when it pauses again). Throws for an id no
   * channel turn paused on.
   */
  resolveApproval(decision: ChannelApprovalDecision, respond?: ChannelRespond): Promise<void>;
}

const FAILED_TEXT = 'Sorry, that request failed.';

/** The reply to a decision that leaves other calls of its step undecided. */
function stillWaiting(approvals: readonly PendingApproval[]): string {
  const left = approvals.map((approval) => `${approval.toolName} (approval id: ${approval.id})`).join(', ');
  return `Decision recorded. Still waiting on: ${left}.`;
}

interface PausedTurn {
  channel: Channel;
  inbound: ChannelInbound;
  sessionId: string;
}

/** A channel request's header `name` (lowercase), list values joined as `node:http` would. */
function headerOf(req: ChannelRequest, name: string): string | null {
  const value = req.headers[name];
  return value === undefined ? null : Array.isArray(value) ? value.join(', ') : value;
}

/**
 * Whether `req` to a channel without `verify` comes from a web page on
 * another site. A webhook sender or a server sends no `Origin`; a browser
 * does, so with nothing else to authenticate the request, a page on another
 * site must not start a turn (or decide a pause) on the user's behalf.
 */
function crossSiteToOpenChannel(channel: Channel, req: ChannelRequest): boolean {
  return !channel.verify && crossSiteRequest({ get: (name) => headerOf(req, name) }, undefined);
}

async function isAuthorized(channel: Channel, req: ChannelRequest): Promise<boolean> {
  if (!channel.verify) return true;
  const verdict = await channel.verify(req);
  return typeof verdict === 'boolean' ? verdict : verdict.ok;
}

/**
 * The decision in an approvals-route body, or undefined when it has neither `approved` nor `answer`.
 * An optional `sessionKey` names the conversation, so a pause this process forgot can still be bound.
 */
function readDecision(id: string, text: string): { decision: ChannelApprovalDecision; sessionKey?: string } | undefined {
  const { approved, note, answer, sessionKey } = (JSON.parse(text || '{}') ?? {}) as Record<string, unknown>;
  const key = typeof sessionKey === 'string' && sessionKey ? { sessionKey } : {};
  if (typeof answer === 'string') return { decision: { id, answer }, ...key };
  if (typeof approved === 'boolean') return { decision: { id, approved, note: typeof note === 'string' ? note : undefined }, ...key };
  return undefined;
}

/**
 * Who decided a pause on a surface: the clicking user as a principal of the channel
 * (`{ id, type: 'user', authenticator: <channel name> }`), else - an answer sent as a message - the
 * message's verified sender. `undefined` for a decision posted to the approvals route, which names nobody.
 */
function approverPrincipal(channel: Channel, approver: ChannelUser | undefined, inbound: ChannelInbound | undefined): Principal | undefined {
  if (approver) return { id: approver.id, type: 'user', authenticator: channel.name };
  return inbound?.principal;
}

/**
 * The `store` of an agent built by `createAgent()` when it keeps
 * session transcripts. A channel's private in-memory transcript next to the
 * agent's durable checkpoints let the two views diverge: `agent.resume(id)`
 * looked for the checkpoint at the durable transcript's length and missed a
 * channel turn's pause.
 */
function agentSessionStores(agent: Pick<SimpleAgent, 'session' | 'approvals'>): SessionStores | undefined {
  const store = createAgentConfigOf(agent as SimpleAgent)?.store;
  return store?.sessions ? { sessions: store.sessions, checkpoints: store.checkpoints } : undefined;
}

/** The agent's approval store, for the snapshot a stored pause was saved with (its session binding). */
function agentApprovalStore(agent: Pick<SimpleAgent, 'session' | 'approvals'>): ApprovalStore | undefined {
  const config = createAgentConfigOf(agent as SimpleAgent);
  return config?.approvalStore ?? config?.store?.approvals;
}

/** The session a stored pause belongs to: `snapshot.contextSessionId`, or `snapshot.sessionId` (`<id>.turn-<n>` spells a checkpointed turn of `<id>`). */
function pausedSessionId(record: ResolvedApproval | null | undefined): string | undefined {
  const snapshot = record?.snapshot;
  if (!snapshot) return undefined;
  if (snapshot.contextSessionId !== undefined) return snapshot.contextSessionId;
  const sessionId = snapshot.sessionId;
  return sessionId === undefined ? undefined : (/^([A-Za-z0-9_-]{1,128})\.turn-\d+$/.exec(sessionId)?.[1] ?? sessionId);
}

/**
 * The channel logic of `mountChannels()`: `handle` serves one inbound request
 * of `channel` (a turn, or a decision when `approvalId` is set); the host
 * supplies the `respond` its transport answers through. `resolveApproval`
 * continues a pause out of band. Channel names must be unique.
 */
export function channelCore(agent: Pick<SimpleAgent, 'session' | 'approvals'>, channels: readonly Channel[], options: ChannelCoreOptions = {}): ChannelCore {
  const names = new Set(channels.map((channel) => channel.name));
  if (names.size !== channels.length) throw new SDKError('channelCore: channel names must be unique', 'LOUSHO_CHANNEL_INVALID');
  const store = options.store ?? agentSessionStores(agent) ?? new MemorySessionStore();
  const paused = new Map<string, PausedTurn>();
  const tails = new Map<string, Promise<unknown>>();
  /** Question ids `pendingQuestion` handed out whose answer has not been processed yet. */
  const claimed = new Set<string>();
  const answered = new WeakSet<ChannelRespond>();
  /** Approval ids a decision is in flight for; a second decision on one is a conflict, not a race. */
  const deciding = new Set<string>();
  const stores = withDefaultStores({ store });
  const sessions = stores.store as SessionStore | undefined;
  /** #279: `store` has checkpoints, so a session tells which pause its turn waits on, also after a restart. */
  const checkpointed = stores.checkpointStore !== undefined;
  /** the durable approval store, whose snapshots bind a pause to the session it paused in. */
  const approvalStore = agentApprovalStore(agent);

  /** What `channel.parse` may ask: the agent's pending approvals and saved sessions. */
  function contextFor(channel: Channel): ChannelContext {
    const sessionId = (sessionKey: string) => channelSessionId(channel, { sessionKey, input: '', replyTo: undefined });
    return {
      // #280: this process's pauses first, then the durable approval store, so a function `approvers` still decides after a restart.
      approval: async (id) => (await agent.approvals.list()).find((request) => request.id === id) ?? (await agent.approvals.get?.(id)),
      sessionId,
      hasSession: async (sessionKey) => (await sessions?.load(sessionId(sessionKey))) !== undefined,
      pendingQuestion: (sessionKey) => {
        const id = sessionId(sessionKey);
        return serialized(id, async () => {
          const question = await questionOf(id);
          if (question === undefined || claimed.has(question)) return undefined;
          claimed.add(question);
          return question;
        });
      },
    };
  }

  /**
   * The `ask_question` session `sessionId` waits on. A pause of this process is in `paused`;
   * after a restart, the session's checkpoint says whether its turn waits on a question, and
   * `resume()` (which throws `SessionAwaitingApprovalError`) binds that approval to the session, so
   * the answer's continuation is appended to its transcript.
   */
  async function questionOf(sessionId: string): Promise<string | undefined> {
    const known = [...paused].find(([, turn]) => turn.sessionId === sessionId)?.[0];
    if (known !== undefined) return (await agent.approvals.list()).find((request) => request.id === known)?.kind === 'question' ? known : undefined;
    const session = agent.session({ id: sessionId, store });
    const pending = await session.pending();
    if (pending?.status !== 'awaiting-approval' || pending.approvalKind !== 'question') return undefined;
    try {
      await session.resume();
    } catch (error) {
      if (error instanceof SessionAwaitingApprovalError && error.approvalId === pending.approvalId) return error.approvalId;
      throw error;
    }
    return undefined;
  }

  /**
   * Runs `fn`. A failure after the surface was answered (`respond` was called) goes to
   * `onError` and, unless it was the reply itself, the user is told the request failed;
   * before that (or with no `respond`) it is thrown to the caller as ever.
   */
  async function guard(turn: PausedTurn, stage: 'turn' | 'reply' | 'approval', respond: ChannelRespond | undefined, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      if (!respond || !answered.has(respond)) throw error;
      await reportChannelError(turn.channel.onError ?? options.onError, error, { channel: turn.channel.name, stage, sessionId: turn.sessionId });
      if (stage !== 'reply') await guard(turn, 'reply', respond, () => turn.channel.reply({ inbound: turn.inbound, sessionId: turn.sessionId, text: FAILED_TEXT, respond }));
    }
  }

  /** Runs `turn` after the session's previous turn has settled. */
  function serialized<T>(sessionId: string, turn: () => Promise<T>): Promise<T> {
    const next = (tails.get(sessionId) ?? Promise.resolve()).then(turn);
    const tail = next.catch(() => undefined);
    tails.set(sessionId, tail);
    void tail.then(() => tails.get(sessionId) === tail && tails.delete(sessionId));
    return next;
  }

  /**
   * Replies with the turn's result, or hands a pause to `onApproval` (default: a text prompt via `reply`).
   * A step paused on several calls hands each to `onApproval` once (only the first gets
   * `respond`); a decision that leaves others of its step pending replies with what is left.
   */
  async function finish(turn: PausedTurn, result: ExecutionResult, events: AgentEvent[] | undefined, respond?: ChannelRespond): Promise<void> {
    const { channel, inbound, sessionId } = turn;
    const ids = result.finishReason === 'awaiting-approval' ? (result.approvalIds ?? (result.approvalId === undefined ? [] : [result.approvalId])) : [];
    const pending = ids.length > 0 ? await agent.approvals.list() : [];
    const approvals = ids.flatMap((id) => pending.filter((request) => request.id === id));
    if (approvals.length === 0) return guard(turn, 'reply', respond, () => channel.reply({ inbound, sessionId, text: result.text, result, events, respond }));
    const fresh = approvals.filter((approval) => !paused.has(approval.id));
    for (const approval of approvals) paused.set(approval.id, turn);
    const group = approvals.length > 1 ? { approvals } : {};
    if (fresh.length === 0) {
      return guard(turn, 'reply', respond, () => channel.reply({ inbound, sessionId, text: stillWaiting(approvals), result, ...group, respond }));
    }
    for (const [index, approval] of fresh.entries()) {
      const ctx = { inbound, sessionId, text: approvalPrompt(approval), result, events, approval, ...group, ...(index === 0 && { respond }) };
      await guard(turn, 'reply', respond, () => (channel.onApproval ? channel.onApproval(ctx) : channel.reply(ctx)));
    }
  }

  function runTurn(turn: PausedTurn, respond: ChannelRespond): Promise<void> {
    const { channel, inbound, sessionId } = turn;
    return guard(turn, 'turn', respond, async () => {
      const run = agent.session({ id: sessionId, store }).stream(inbound.input, { principal: inbound.principal, metadata: inbound.metadata });
      const events: AgentEvent[] = [];
      let text = '';
      for await (const event of run) {
        events.push(event);
        if (!channel.stream || event.type !== 'text.delta') continue;
        text += event.text;
        await guard(turn, 'reply', respond, () => channel.reply({ inbound, sessionId, text, partial: true, respond }));
      }
      await finish(turn, await run.result, events, respond);
    });
  }

  /**
   * #279: a decision this process did not pause on (a click after a restart). With checkpointed
   * sessions it must name a conversation whose turn waits on exactly this pause, of the matching
   * kind (a button decides a tool call, an answer a question); `resume()` then binds the pause to
   * the session (`SessionAwaitingApprovalError`), so the continuation joins its transcript. Anything
   * else - another conversation, a replay, a forged id - is refused before the approval is touched.
   * Without a checkpoint store the session cannot tell, so the pause's stored
   * snapshot must: it names the session the paused turn ran in, and only a decision that
   * names that same conversation may bind. A `sessionKey` that maps to another session -
   * or to no session the pause knows - is refused, as is a kind mismatch.
   */
  async function bindToSession(sessionId: string, decision: ChannelApprovalDecision): Promise<boolean> {
    const session = agent.session({ id: sessionId, store });
    const pending = await session.pending();
    const isAnswer = typeof decision.answer === 'string';
    if (!pending) {
      if (checkpointed) return false;
      const record = await approvalStore?.load?.(decision.id);
      const bound = pausedSessionId(record) ?? (await agent.approvals.get?.(decision.id))?.sessionId;
      if (bound !== sessionId) return false;
      const kind = record ? describeApproval(record.pending).kind ?? 'tool' : 'tool';
      return isAnswer === (kind === 'question') && kind !== 'sign-in';
    }
    // A turn paused on several calls of one step waits on each of them.
    const ids = pending.approvalIds ?? (pending.approvalId === undefined ? [] : [pending.approvalId]);
    if (pending.status !== 'awaiting-approval' || !ids.includes(decision.id)) return false;
    const approval = decision.id === pending.approvalId ? undefined : await agent.approvals.get(decision.id);
    const kind = (decision.id === pending.approvalId ? pending.approvalKind : approval ? describeApproval(approval).kind : undefined) ?? 'tool';
    if (isAnswer !== (kind === 'question') || kind === 'sign-in') return false;
    try {
      await session.resume();
    } catch (error) {
      if (error instanceof SessionAwaitingApprovalError && error.approvalId !== undefined && ids.includes(error.approvalId)) return true;
      throw error;
    }
    return false;
  }

  /** #279: a decision that names no pending turn of this conversation: 404 while the request is open, else a failure (`onError`). */
  function refuse(channel: Channel, id: string, respond: ChannelRespond | undefined): void {
    const error = new SDKError(`No pending approval '${id}' in this conversation on channel '${channel.name}'`, 'LOUSHO_APPROVAL_NOT_FOUND');
    if (!respond || answered.has(respond)) throw error;
    respond(404, { error: error.message });
  }

  /**
   * A decision on an approval another request decided (or is deciding): 409 while the
   * request is open, like the session routes' `decisionGate`; a no-op once the surface was answered.
   */
  function conflict(respond: ChannelRespond): void {
    if (answered.has(respond)) return;
    respond(409, { error: 'This approval was decided by another request', code: 'LOUSHO_APPROVAL_CONFLICT' });
  }

  /** Runs `fn` with `id` claimed, so a concurrent decision on it cannot start. */
  async function claiming(id: string, fn: () => Promise<void>): Promise<void> {
    deciding.add(id);
    try {
      await fn();
    } finally {
      deciding.delete(id);
    }
  }

  /**
   * Decides the pause `turn` stopped on and delivers the continuation, as the session's next turn.
   * `approver` is recorded as who decided (`ctx.approval.by`); the run keeps its own principal.
   * `accept` (#279) runs first, in the session's queue: it checks the decision and audits it, or refuses it.
   */
  function continueTurn(
    turn: PausedTurn,
    decision: ChannelApprovalDecision,
    respond?: ChannelRespond,
    approver?: Principal,
    accept?: () => Promise<boolean>
  ): Promise<void> {
    paused.delete(decision.id);
    const { id, approved, note, answer } = decision;
    const decided = { ...(approver && { principal: approver }) };
    const run = () =>
      guard(turn, 'approval', respond, async () => {
        if (accept && !(await accept())) return refuse(turn.channel, id, respond);
        const decide = () =>
          typeof answer === 'string' ? agent.approvals.answer({ id, answer }, decided) : agent.approvals.resolve({ id, approved: approved === true, note }, decided);
        const result = await decide().catch((error: unknown) => {
          // Approved before the user signed in: the pause stays, and so does this turn's binding to it.
          if (error instanceof Error && error.name === 'SignInPendingError') paused.set(id, turn);
          // Decided meanwhile by another path (the session routes, another replica): a conflict, not a failure.
          if (respond && error instanceof SDKError && error.code === 'LOUSHO_APPROVAL_NOT_FOUND') return undefined;
          throw error;
        });
        if (!result) return conflict(respond!);
        await finish(turn, result, undefined, respond);
      });
    return serialized(turn.sessionId, run).finally(() => claimed.delete(id));
  }

  async function resolveApproval(decision: ChannelApprovalDecision, respond?: ChannelRespond): Promise<void> {
    const turn = paused.get(decision.id);
    if (!turn) throw new SDKError(`No pending channel approval '${decision.id}'`, 'LOUSHO_APPROVAL_NOT_FOUND');
    if (deciding.has(decision.id)) throw new SDKError(`Channel approval '${decision.id}' is being decided by another request`, 'LOUSHO_APPROVAL_CONFLICT');
    await claiming(decision.id, () => continueTurn(turn, decision, respond));
  }

  async function handle(channel: Channel, approvalId: string | undefined, req: ChannelRequest, respond: ChannelRespond): Promise<void> {
    /** `respond`, marked in `answered` on its first call, so `guard` can tell a pre-ack failure from a post-ack one. */
    const tracked: ChannelRespond = (status, body) => {
      answered.add(tracked);
      respond(status, body);
    };
    if (crossSiteToOpenChannel(channel, req)) {
      const error = `Cross-site request refused: channel '${channel.name}' has no verify. To accept a page on another site, add a verify that authenticates its requests (e.g. a bearer token).`;
      return tracked(403, { error, code: 'LOUSHO_REQUEST_FORBIDDEN' });
    }
    if (!(await isAuthorized(channel, req))) return tracked(401, { error: 'Unauthorized' });
    if (approvalId === undefined) {
      const inbound = await channel.parse(req, tracked, contextFor(channel));
      if (!inbound || 'decision' in inbound) return inbound ? decide(channel, inbound, tracked) : undefined;
      const turn = { channel, inbound, sessionId: channelSessionId(channel, inbound) };
      return serialized(turn.sessionId, () => runTurn(turn, tracked));
    }
    const body = readDecision(approvalId, req.text);
    if (!body) return tracked(400, { error: "Request body must be JSON with 'approved' (and optional 'note') or 'answer'" });
    const { decision, sessionKey } = body;
    const known = paused.get(decision.id);
    // The conversation the body names, for a pause this process forgot (a restart, another replica). A pause
    // it remembers keeps its own inbound (where the reply goes); the named conversation must still be the one that paused.
    const named: ChannelInbound | undefined = sessionKey === undefined ? undefined : { sessionKey, input: '', replyTo: known?.inbound.replyTo ?? null };
    const sameAsKnown = known && named && channelSessionId(channel, named) === known.sessionId;
    await decide(channel, { decision, ...(named && !sameAsKnown && { inbound: named }) }, tracked);
  }

  /**
   * Resolves the decision when `channel` paused on it in this process (a click must name that
   * conversation), or when the click names the conversation itself (`inbound`: it survives a
   * restart) and, with checkpointed sessions, that conversation's turn waits on it (#279); else 404.
   */
  async function decide(channel: Channel, { decision, inbound, approver }: ChannelDecision, respond: ChannelRespond): Promise<void> {
    const known = paused.get(decision.id);
    const turn = inbound ? { channel, inbound, sessionId: channelSessionId(channel, inbound) } : known;
    if (!turn || (known && (known.channel !== channel || known.sessionId !== turn.sessionId))) {
      return respond(404, { error: `No pending approval '${decision.id}' on channel '${channel.name}'` });
    }
    // Claimed before the first await (`onDecision`), so a double click cannot decide twice.
    if (deciding.has(decision.id)) return conflict(respond);
    await claiming(decision.id, () => decideClaimed(channel, turn, known, { decision, inbound, approver }, respond));
  }

  async function decideClaimed(channel: Channel, turn: PausedTurn, known: PausedTurn | undefined, { decision, inbound, approver }: ChannelDecision, respond: ChannelRespond): Promise<void> {
    const audit = async () => {
      if (approver) await options.onDecision?.({ decision, approver, sessionId: turn.sessionId, channel: channel.name });
    };
    const principal = approverPrincipal(channel, approver, inbound);
    if (known) {
      await audit();
      return continueTurn(turn, decision, respond, principal);
    }
    const accept = async (): Promise<boolean> => {
      if (!(await bindToSession(turn.sessionId, decision))) return false;
      await audit();
      return true;
    };
    await continueTurn(turn, decision, respond, principal, accept);
  }

  return { handle, resolveApproval };
}

/**
 * After the OAuth callback stored a user's token (or the user declined),
 * continues the channel turn this process paused on that sign-in, so the
 * answer is posted to the surface it was asked on. A sign-in that no channel
 * turn of this process waits on is left alone (a client continues it with the
 * approvals route). Not awaited: the continuation can take a while.
 */
export function continueChannelSignIn(
  channels: { resolveApproval(decision: ChannelApprovalDecision, respond?: ChannelRespond): Promise<void> } | undefined,
  result: { approvalId?: string }
): void {
  if (!channels || result.approvalId === undefined) return;
  void channels.resolveApproval({ id: result.approvalId, approved: true }).catch(reportSignInContinuation);
}

/** A sign-in no channel turn of this process waits on is fine; anything else is logged. */
function reportSignInContinuation(error: unknown): void {
  if (error instanceof SDKError && error.code === 'LOUSHO_APPROVAL_NOT_FOUND') return;
  console.error('[lousho channels] continuing a turn after sign-in failed:', (error as Error | null)?.message ?? error);
}
