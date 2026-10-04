/**
 * The `mountChannels()` routes on the Fetch API (Request in, Response out),
 * so a Cloudflare Worker - or any Fetch host - serves the same channels:
 *
 *   POST <basePath>/<name>                verify -> parse -> a session turn (or a decision) -> reply
 *   POST <basePath>/<name>/approvals/:id  verify -> { approved, note? } or { answer } -> the continuation's reply
 *
 * The channel logic is ./channelCore.ts, shared with `mountChannels()`
 * (./mountChannels.ts, `node:http`). No `node:*` import.
 */
import type { SimpleAgent } from '../createAgent';
import type { SessionStore } from '../session/sessionStore';
import type { SessionStores } from '../session/AgentSession';
import {
  type Channel,
  type ChannelApprovalDecision,
  type ChannelDecision,
  type ChannelErrorHandler,
  type ChannelRequest,
  type ChannelRespond,
} from './defineChannel';
import { reportChannelError } from './channelSupport';
import { channelCore } from './channelCore';
import { SDKError } from '../execution/errors';

/** Options of {@link mountFetchChannels} (the `MountChannelsOptions` of `mountChannels()`). */
export interface FetchChannelsOptions {
  /**
   * Where the channels' transcripts are kept (e.g. the agent's store - a
   * `KVStore` on Workers). Defaults to an in-memory store owned by this handler.
   */
  store?: SessionStore | SessionStores;
  /** Path prefix of the routes. Default `/channels`. */
  basePath?: string;
  /** Fallback for a channel without its own `onError`: failures after the request was acknowledged. Default: `console.error`. */
  onError?: ChannelErrorHandler;
  /** Called when a button decision names who decided (the Slack and Discord channels do): the audit trail of approvals. */
  onDecision?(event: { decision: ChannelApprovalDecision; approver: NonNullable<ChannelDecision['approver']>; sessionId: string; channel: string }): void | Promise<void>;
}

/** The optional ExecutionContext of a Fetch host: keeps work alive after the response. */
export interface FetchChannelsContext {
  waitUntil?(promise: Promise<unknown>): void;
}

/** The handler {@link mountFetchChannels} returns. */
export interface FetchChannelsHandler {
  /** Answers `request` when it is a channel route; resolves `undefined` for any other request. */
  (request: Request, ctx?: FetchChannelsContext): Promise<Response | undefined>;
  /** The `resolveApproval` of `mountChannels()`: decides a pause a channel turn stopped on. */
  resolveApproval(decision: ChannelApprovalDecision, respond?: ChannelRespond): Promise<void>;
}

/** Body-size cap, matching `readRawBody()` and the Fetch chat routes' 1MB limit. */
const MAX_BODY_BYTES = 1024 * 1024; // 1MB

class PayloadTooLargeError extends Error {}

/** The request body's exact bytes (signatures are checked over these), at most MAX_BODY_BYTES. */
async function readRequestBytes(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  // Past the cap the body stops growing but is still drained, so the client
  // can finish writing and the connection does not deadlock; 413 follows.
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    bytes += chunk.value.byteLength;
    if (bytes <= MAX_BODY_BYTES) chunks.push(chunk.value);
  }
  if (bytes > MAX_BODY_BYTES) throw new PayloadTooLargeError(`Request body exceeds ${MAX_BODY_BYTES} byte limit`);
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The error status for a failed handler: 413 over the size cap, 400 for bad JSON, else 500. */
function failureResponse(error: unknown): Response {
  const status = error instanceof PayloadTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 500;
  return jsonResponse(status, { error: (error as Error).message });
}

/** The answer a channel's first `respond` call wrote, once `acknowledged` settles. */
interface PendingAnswer {
  current?: { status: number; body: unknown };
}

/**
 * The response once the turn was dispatched. Races the surface's `respond`
 * answer against the turn ending: an early answer wins and the turn keeps
 * running past the response (kept alive by `ctx.waitUntil` or by awaiting its
 * error tail here); a `handle` that threw after acknowledging reports the
 * error but keeps the answer standing (as in mountChannels).
 */
async function settledResponse(
  turn: Promise<void>,
  acknowledged: Promise<void>,
  answer: PendingAnswer,
  ctx: FetchChannelsContext | undefined,
  report: (error: unknown) => Promise<void>
): Promise<Response> {
  const settled = await Promise.race([acknowledged.then(() => 'ack' as const), turn.then(() => 'done' as const, (error: unknown) => ({ error }))]);
  if (settled === 'ack') {
    // The surface was answered before the turn ended: keep the turn alive
    // past the response (ctx.waitUntil, or by awaiting it here).
    const tail = turn.catch(report);
    if (ctx?.waitUntil) ctx.waitUntil(tail);
    else await tail;
    const answered = answer.current as { status: number; body: unknown };
    return jsonResponse(answered.status, answered.body);
  }
  if (settled !== 'done') {
    // `handle` threw: acknowledged already -> report, else a JSON failure.
    if (answer.current !== undefined) {
      await report(settled.error);
      return jsonResponse(answer.current.status, answer.current.body);
    }
    return failureResponse(settled.error);
  }
  return jsonResponse(answer.current?.status ?? 200, answer.current?.body ?? { ok: true });
}

/**
 * Serves `channels` for `agent` on the Fetch API, with the same routes and
 * rules as `mountChannels()`: `POST <basePath>/<channel.name>` runs the
 * channel's verify -> parse -> turn -> reply; a `null` parse acknowledges
 * with `200 {"ok":true}`.
 *
 * When a channel's `parse` acknowledges the request early (its `respond`
 * call), the answer is returned as soon as it is written and the turn keeps
 * running: handed to `ctx.waitUntil()` when the host passes one (a Worker's
 * ExecutionContext), awaited before the answer otherwise.
 *
 * @example
 * ```ts
 * const channels = mountFetchChannels(agent, [httpChannel()]);
 * export default { fetch: (request: Request, _env: unknown, ctx: ExecutionContext) =>
 *   (await channels(request, ctx)) ?? new Response('not found', { status: 404 }) };
 * ```
 */
export function mountFetchChannels(
  agent: Pick<SimpleAgent, 'session' | 'approvals'>,
  channels: readonly Channel[],
  options: FetchChannelsOptions = {}
): FetchChannelsHandler {
  const basePath = (options.basePath ?? '/channels').replace(/\/+$/, '');
  const byName = new Map(channels.map((channel) => [channel.name, channel]));
  if (byName.size !== channels.length) throw new SDKError('mountFetchChannels: channel names must be unique', 'LOUSHO_CHANNEL_INVALID');
  const core = channelCore(agent, channels, options);

  const handler = async (request: Request, ctx?: FetchChannelsContext): Promise<Response | undefined> => {
    const { pathname, search } = new URL(request.url);
    const route = request.method === 'POST' && pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length + 1).split('/') : [];
    const channel = byName.get(route[0] ?? ''); // names need no decoding: [A-Za-z0-9_-] only
    const isApproval = route.length === 3 && route[1] === 'approvals';
    if (!channel || (route.length !== 1 && !isApproval)) return undefined;
    /** A failure after the surface was acknowledged: reported, the ack stands (as in mountChannels). */
    const report = (error: unknown) => reportChannelError(channel.onError ?? options.onError, error, { channel: channel.name, stage: 'parse' });
    /** The first `respond` call, as both the stored answer and a promise that settles then. */
    const answer: PendingAnswer = {};
    let acknowledge!: () => void;
    const acknowledged = new Promise<void>((resolve) => (acknowledge = resolve));
    const respond: ChannelRespond = (status, body) => {
      if (answer.current !== undefined) return;
      answer.current = { status, body };
      acknowledge();
    };
    let turn: Promise<void>;
    try {
      const rawBody = await readRequestBytes(request);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => (headers[name] = value));
      const req: ChannelRequest = {
        method: request.method,
        url: pathname + search,
        headers,
        rawBody,
        text: new TextDecoder().decode(rawBody),
        native: request,
      };
      turn = core.handle(channel, isApproval ? decodeURIComponent(route[2]) : undefined, req, respond);
    } catch (error) {
      return failureResponse(error);
    }
    return settledResponse(turn, acknowledged, answer, ctx, report);
  };
  return Object.assign(handler, { resolveApproval: core.resolveApproval });
}
