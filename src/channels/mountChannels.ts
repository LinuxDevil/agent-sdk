/**
 * Runs channels (LOU-P7) behind one framework-free `(req, res)` handler, in
 * the style of the `/chat` routes (src/server/chatRoutes.ts):
 *
 *   POST <basePath>/<name>                verify -> parse -> a session turn (or a decision) -> reply
 *   POST <basePath>/<name>/approvals/:id  verify -> { approved, note? } or { answer } -> the continuation's reply
 *
 * The channel logic itself lives in ./channelCore.ts (Node-free, so the Fetch
 * adapter ./fetchChannels.ts serves the same channels in a Worker); this file
 * is only the `node:http` plumbing.
 */
import type * as http from 'node:http';
import type { SimpleAgent } from '../createAgent';
import type { SessionStore } from '../session/sessionStore';
import type { SessionStores } from '../session/AgentSession';
import { readRawBody, sendFailure, sendJson } from '../server/chatRoutes';
import {
  toChannelRequest,
  type Channel,
  type ChannelApprovalDecision,
  type ChannelDecision,
  type ChannelErrorHandler,
  type ChannelRespond,
} from './defineChannel';
import { reportChannelError } from './channelSupport';
import { channelCore, type ChannelCore } from './channelCore';
import { SDKError } from '../execution/errors';

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
  const byName = new Map(channels.map((channel) => [channel.name, channel]));
  if (byName.size !== channels.length) throw new SDKError('mountChannels: channel names must be unique', 'LOUSHO_CHANNEL_INVALID');
  const core: ChannelCore = channelCore(agent, channels, options);
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
      await core.handle(channel, isApproval ? decodeURIComponent(route[2]) : undefined, request, respond);
      respond(200, { ok: true });
    } catch (error) {
      if (responded) await reportChannelError(channel.onError ?? options.onError, error, { channel: channel.name, stage: 'parse' });
      else sendFailure(res, error);
      responded = true;
    }
    return true;
  };
  return Object.assign(handler, { resolveApproval: core.resolveApproval });
}

/**
 * N9b: after the OAuth callback stored a user's token (or the user declined),
 * continues the channel turn this process paused on that sign-in, so the
 * answer is posted to the surface it was asked on. A sign-in that no channel
 * turn of this process waits on is left alone (a client continues it with the
 * approvals route). Not awaited: the continuation can take a while.
 */
export { continueChannelSignIn } from './channelCore';
