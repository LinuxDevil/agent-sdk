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
import type { SessionStores } from '../session/AgentSession';
import { readRawBody, sendFailure, sendJson } from '../server/chatRoutes';
import {
  approvalPrompt,
  channelSessionId,
  toChannelRequest,
  type Channel,
  type ChannelApprovalDecision,
  type ChannelInbound,
  type ChannelRequest,
  type ChannelRespond,
} from './defineChannel';

/** Options of {@link mountChannels}. */
export interface MountChannelsOptions {
  /**
   * Where the channels' transcripts are kept (e.g. the `SqliteStore` the agent
   * uses). Defaults to an in-memory store owned by this handler.
   */
  store?: SessionStore | SessionStores;
  /** Path prefix of the routes. Default `/channels`. */
  basePath?: string;
}

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
 * Serves `channels` for `agent`: `POST <basePath>/<channel.name>` runs the
 * channel's verify -> parse -> turn in session `channelSessionId()` -> reply.
 * A failed `verify` answers 401, a `null` parse acknowledges with
 * `200 {"ok":true}`, and a reply that does not `respond` itself is followed
 * by `200 {"ok":true}`. Turns of one session run one at a time.
 *
 * @example
 * ```ts
 * import * as http from 'node:http';
 * import { createAgent, createMockProvider, httpChannel, mountChannels } from '@loushy/build-ai-agent';
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
  if (byName.size !== channels.length) throw new Error('mountChannels: channel names must be unique');
  const paused = new Map<string, PausedTurn>();
  const tails = new Map<string, Promise<void>>();

  /** Runs `turn` after the session's previous turn has settled. */
  function serialized(sessionId: string, turn: () => Promise<void>): Promise<void> {
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
    if (!approval) return channel.reply({ inbound, sessionId, text: result.text, result, events, respond });
    paused.set(approval.id, turn);
    const ctx = { inbound, sessionId, text: approvalPrompt(approval), result, events, approval, respond };
    await (channel.onApproval ? channel.onApproval(ctx) : channel.reply(ctx));
  }

  async function runTurn(turn: PausedTurn, respond: ChannelRespond): Promise<void> {
    const { channel, inbound, sessionId } = turn;
    const run = agent.session({ id: sessionId, store }).stream(inbound.input);
    const events: AgentEvent[] = [];
    let text = '';
    for await (const event of run) {
      events.push(event);
      if (!channel.stream || event.type !== 'text.delta') continue;
      text += event.text;
      await channel.reply({ inbound, sessionId, text, partial: true, respond });
    }
    await finish(turn, await run.result, events, respond);
  }

  async function resolveApproval(decision: ChannelApprovalDecision, respond?: ChannelRespond): Promise<void> {
    const turn = paused.get(decision.id);
    if (!turn) throw new Error(`No pending channel approval '${decision.id}'`);
    paused.delete(decision.id);
    const { id, approved, note, answer } = decision;
    const result =
      typeof answer === 'string' ? await agent.approvals.answer({ id, answer }) : await agent.approvals.resolve({ id, approved: approved === true, note });
    await finish(turn, result, undefined, respond);
  }

  async function handle(channel: Channel, approvalId: string | undefined, req: ChannelRequest, respond: ChannelRespond): Promise<void> {
    if (!(await isAuthorized(channel, req))) return respond(401, { error: 'Unauthorized' });
    if (approvalId === undefined) {
      const inbound = await channel.parse(req, respond);
      if (!inbound || 'decision' in inbound) return inbound ? decide(channel, inbound.decision, respond) : undefined;
      const turn = { channel, inbound, sessionId: channelSessionId(channel, inbound) };
      return serialized(turn.sessionId, () => runTurn(turn, respond));
    }
    const decision = readDecision(approvalId, req.text);
    if (!decision) return respond(400, { error: "Request body must be JSON with 'approved' (and optional 'note') or 'answer'" });
    await decide(channel, decision, respond);
  }

  /** Resolves `decision` when `channel` paused on it, else answers 404. */
  async function decide(channel: Channel, decision: ChannelApprovalDecision, respond: ChannelRespond): Promise<void> {
    if (paused.get(decision.id)?.channel !== channel) return respond(404, { error: `No pending approval '${decision.id}' on channel '${channel.name}'` });
    await resolveApproval(decision, respond);
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
    };
    try {
      const request = toChannelRequest(req, await readRawBody(req));
      await handle(channel, isApproval ? decodeURIComponent(route[2]) : undefined, request, respond);
      respond(200, { ok: true });
    } catch (error) {
      if (!responded) sendFailure(res, error);
      responded = true;
    }
    return true;
  };
  return Object.assign(handler, { resolveApproval });
}
