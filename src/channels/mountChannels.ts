/**
 * Runs channels (LOU-P7) behind one framework-free `(req, res)` handler, in
 * the style of the `/chat` routes (src/server/chatRoutes.ts):
 *
 *   POST <basePath>/<name>                verify -> parse -> a session turn (or a decision) -> reply
 *   POST <basePath>/<name>/approvals/:id  verify -> { approved, note? } or { answer } -> the continuation's reply
 *
 * No runtime `node:*` import (the node types are type-only).
 */
import type * as http from 'node:http';
import type { SimpleAgent } from '../createAgent';
import type { ExecutionResult } from '../execution/AgentExecutor';
import type { AgentEvent } from '../execution/agentEvents';
import { MemorySessionStore, type SessionStore } from '../session/sessionStore';
import { withDefaultStores, type SessionStores } from '../session/AgentSession';
import { readRawBody, sendFailure, sendJson } from '../server/chatRoutes';
import {
  approvalPrompt,
  channelSessionId,
  toChannelRequest,
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
import { SDKError, SessionAwaitingApprovalError } from '../execution/errors';

/** Options of {@link mountChannels}. */
export interface MountChannelsOptions {
  /**
   * Where the channels' transcripts are kept (e.g. the `SqliteStore` the agent
   * uses). Defaults to an in-memory store owned by this handler.
   */
  store?: SessionStore | SessionStores;
  /** Path prefix of the routes. Default `/channels`. */
  basePath?: string;
  /** Fallback for a channel without its own `onError`: failures after the request was acknowledged. Default: `console.error`. */
  onError?: ChannelErrorHandler;
  /** Called when a button decision names who decided (the Slack and Discord channels do): the audit trail of approvals. */
  onDecision?(event: { decision: ChannelApprovalDecision; approver: NonNullable<ChannelDecision['approver']>; sessionId: string; channel: string }): void | Promise<void>;
}

const FAILED_TEXT = 'Sorry, that request failed.';

/** The handler `mountChannels()` returns. */
export interface ChannelsHandler {
  /** Handles a channel route and resolves `true`; resolves `false` (nothing written) for any other request. */
  (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
  /**
   * Decides a pause a channel turn stopped on (e.g. from a surface's button
   * callback) and delivers the continuation through the same channel's
   * `reply` (or `onApproval`, when it pauses again). Throws for an id no
   * channel turn paused on.
   */
  resolveApproval(decision: ChannelApprovalDecision, respond?: ChannelRespond): Promise<void>;
}

interface PausedTurn {
  channel: Channel;
  inbound: ChannelInbound;
  sessionId: string;
}

async function isAuthorized(channel: Channel, req: ChannelRequest): Promise<boolean> {
  if (!channel.verify) return true;
  const verdict = await channel.verify(req);
  return typeof verdict === 'boolean' ? verdict : verdict.ok;
}

/** The decision in an approvals-route body, or undefined when it has neither `approved` nor `answer`. */
function readDecision(id: string, text: string): ChannelApprovalDecision | undefined {
  const { approved, note, answer } = (JSON.parse(text || '{}') ?? {}) as Record<string, unknown>;
  if (typeof answer === 'string') return { id, answer };
  if (typeof approved === 'boolean') return { id, approved, note: typeof note === 'string' ? note : undefined };
  return undefined;
}

/**
 * N10b: who decided a pause on a surface: the clicking user as a principal of the channel
 * (`{ id, type: 'user', authenticator: <channel name> }`), else - an answer sent as a message - the
 * message's verified sender. `undefined` for a decision posted to the approvals route, which names nobody.
 */
function approverPrincipal(channel: Channel, approver: ChannelUser | undefined, inbound: ChannelInbound | undefined): Principal | undefined {
  if (approver) return { id: approver.id, type: 'user', authenticator: channel.name };
  return inbound?.principal;
}

/**
 * Serves `channels` for `agent`: `POST <basePath>/<channel.name>` runs the
 * channel's verify -> parse -> turn in session `channelSessionId()` -> reply.
 * A failed `verify` answers 401, a `null` parse acknowledges with
 * `200 {"ok":true}`, and a reply that does not `respond` itself is followed
 * by `200 {"ok":true}`. Turns of one session run one at a time.
 *
 * @example
 * ```ts
 * import * as http from 'node:http';
 * import { createAgent, createMockProvider, httpChannel, mountChannels } from '@lousho/build-ai-agent';
 *
 * const agent = createAgent({ prompt: 'You are helpful.', provider: createMockProvider() });
 * const channels = mountChannels(agent, [httpChannel()]);
 * http.createServer((req, res) => {
 *   void channels(req, res).then((handled) => handled || res.writeHead(404).end());
 * }).listen(3000);
 * ```
 */
export function mountChannels(
  agent: Pick<SimpleAgent, 'session' | 'approvals'>,
  channels: readonly Channel[],
  options: MountChannelsOptions = {}
): ChannelsHandler {
  const basePath = (options.basePath ?? '/channels').replace(/\/+$/, '');
  const store = options.store ?? new MemorySessionStore();
  const byName = new Map(channels.map((channel) => [channel.name, channel]));
  if (byName.size !== channels.length) throw new SDKError('mountChannels: channel names must be unique', 'LOUSHO_CHANNEL_INVALID');
  const paused = new Map<string, PausedTurn>();
  const tails = new Map<string, Promise<unknown>>();
  /** Question ids `pendingQuestion` handed out whose answer has not been processed yet. */
  const claimed = new Set<string>();
  const answered = new WeakSet<ChannelRespond>();
  const sessions = withDefaultStores({ store }).store as SessionStore | undefined;

  /** What `channel.parse` may ask: the agent's pending approvals and saved sessions. */
  function contextFor(channel: Channel): ChannelContext {
    const sessionId = (sessionKey: string) => channelSessionId(channel, { sessionKey, input: '', replyTo: undefined });
    return {
      approval: async (id) => (await agent.approvals.list()).find((request) => request.id === id),
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
   * M10a: the `ask_question` session `sessionId` waits on. A pause of this process is in `paused`;
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

  /** Replies with the turn's result, or hands a pause to `onApproval` (default: a text prompt via `reply`). */
  async function finish(turn: PausedTurn, result: ExecutionResult, events: AgentEvent[] | undefined, respond?: ChannelRespond): Promise<void> {
    const { channel, inbound, sessionId } = turn;
    const pending = result.finishReason === 'awaiting-approval' ? await agent.approvals.list() : [];
    const approval = pending.find((request) => request.id === result.approvalId);
    if (!approval) return guard(turn, 'reply', respond, () => channel.reply({ inbound, sessionId, text: result.text, result, events, respond }));
    paused.set(approval.id, turn);
    const ctx = { inbound, sessionId, text: approvalPrompt(approval), result, events, approval, respond };
    await guard(turn, 'reply', respond, () => (channel.onApproval ? channel.onApproval(ctx) : channel.reply(ctx)));
  }

  function runTurn(turn: PausedTurn, respond: ChannelRespond): Promise<void> {
    const { channel, inbound, sessionId } = turn;
    return guard(turn, 'turn', respond, async () => {
      const run = agent.session({ id: sessionId, store }).stream(inbound.input, { principal: inbound.principal });
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
   * Decides the pause `turn` stopped on and delivers the continuation, as the session's next turn.
   * N10b: `approver` is recorded as who decided (`ctx.approval.by`); the run keeps its own principal.
   */
  function continueTurn(turn: PausedTurn, decision: ChannelApprovalDecision, respond?: ChannelRespond, approver?: Principal): Promise<void> {
    paused.delete(decision.id);
    const { id, approved, note, answer } = decision;
    const decided = { ...(approver && { principal: approver }) };
    const run = () =>
      guard(turn, 'approval', respond, async () => {
        const decide = () =>
          typeof answer === 'string' ? agent.approvals.answer({ id, answer }, decided) : agent.approvals.resolve({ id, approved: approved === true, note }, decided);
        const result = await decide().catch((error: unknown) => {
          // N9b: approved before the user signed in: the pause stays, and so does this turn's binding to it.
          if (error instanceof Error && error.name === 'SignInPendingError') paused.set(id, turn);
          throw error;
        });
        await finish(turn, result, undefined, respond);
      });
    return serialized(turn.sessionId, run).finally(() => claimed.delete(id));
  }

  async function resolveApproval(decision: ChannelApprovalDecision, respond?: ChannelRespond): Promise<void> {
    const turn = paused.get(decision.id);
    if (!turn) throw new SDKError(`No pending channel approval '${decision.id}'`, 'LOUSHO_APPROVAL_NOT_FOUND');
    await continueTurn(turn, decision, respond);
  }

  async function handle(channel: Channel, approvalId: string | undefined, req: ChannelRequest, respond: ChannelRespond): Promise<void> {
    if (!(await isAuthorized(channel, req))) return respond(401, { error: 'Unauthorized' });
    if (approvalId === undefined) {
      const inbound = await channel.parse(req, respond, contextFor(channel));
      if (!inbound || 'decision' in inbound) return inbound ? decide(channel, inbound, respond) : undefined;
      const turn = { channel, inbound, sessionId: channelSessionId(channel, inbound) };
      return serialized(turn.sessionId, () => runTurn(turn, respond));
    }
    const decision = readDecision(approvalId, req.text);
    if (!decision) return respond(400, { error: "Request body must be JSON with 'approved' (and optional 'note') or 'answer'" });
    await decide(channel, { decision }, respond);
  }

  /**
   * Resolves the decision when `channel` paused on it in this process, or when the click
   * names the conversation itself (`inbound`: it survives a restart); else answers 404.
   */
  async function decide(channel: Channel, { decision, inbound, approver }: ChannelDecision, respond: ChannelRespond): Promise<void> {
    const known = paused.get(decision.id);
    const turn = inbound ? { channel, inbound, sessionId: channelSessionId(channel, inbound) } : known?.channel === channel ? known : undefined;
    if (!turn) return respond(404, { error: `No pending approval '${decision.id}' on channel '${channel.name}'` });
    if (approver) await options.onDecision?.({ decision, approver, sessionId: turn.sessionId, channel: channel.name });
    await continueTurn(turn, decision, respond, approverPrincipal(channel, approver, inbound));
  }

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const route = req.method === 'POST' && pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length + 1).split('/') : [];
    const channel = byName.get(route[0] ?? ''); // names need no decoding: [A-Za-z0-9_-] only
    const isApproval = route.length === 3 && route[1] === 'approvals';
    if (!channel || (route.length !== 1 && !isApproval)) return false;
    let responded = false;
    const respond: ChannelRespond = (status, body) => {
      if (!responded) sendJson(res, status, body);
      responded = true;
      answered.add(respond);
    };
    try {
      const request = toChannelRequest(req, await readRawBody(req));
      await handle(channel, isApproval ? decodeURIComponent(route[2]) : undefined, request, respond);
      respond(200, { ok: true });
    } catch (error) {
      if (responded) await reportChannelError(channel.onError ?? options.onError, error, { channel: channel.name, stage: 'parse' });
      else sendFailure(res, error);
      responded = true;
    }
    return true;
  };
  return Object.assign(handler, { resolveApproval });
}

/**
 * N9b: after the OAuth callback stored a user's token (or the user declined),
 * continues the channel turn this process paused on that sign-in, so the
 * answer is posted to the surface it was asked on. A sign-in that no channel
 * turn of this process waits on is left alone (a client continues it with the
 * approvals route). Not awaited: the continuation can take a while.
 */
export function continueChannelSignIn(channels: Pick<ChannelsHandler, 'resolveApproval'> | undefined, result: { approvalId?: string }): void {
  if (!channels || result.approvalId === undefined) return;
  void channels.resolveApproval({ id: result.approvalId, approved: true }).catch(reportSignInContinuation);
}

/** A sign-in no channel turn of this process waits on is fine; anything else is logged. */
function reportSignInContinuation(error: unknown): void {
  if (error instanceof SDKError && error.code === 'LOUSHO_APPROVAL_NOT_FOUND') return;
  console.error('[lousho channels] continuing a turn after sign-in failed:', (error as Error | null)?.message ?? error);
}
