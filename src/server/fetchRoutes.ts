/**
 * The `/chat` HTTP API of `loushy dev`, of the deployed node server and of the
 * Cloudflare Worker (LOU-D32, LOU-D14, LOU-D51), written once on the Fetch API:
 *
 *   GET  /health                         `ok`, never behind the bearer token
 *   POST /chat                           { sessionId, input } in, the turn streamed as SSE out
 *                                        (`data: <AgentEvent>` frames, then `event: done`);
 *                                        the deprecated { message } still returns the ExecutionResult
 *   GET  /chat/:sessionId                the session's transcript and pending approvals
 *   POST /chat/:sessionId/approvals/:id  { approved, note? } or { answer }, the continuation streamed
 *
 * `Request` in, `Response` out, and no `node:*` import (this file is bundled
 * into Workers): chatRoutes.ts adapts it to `node:http`, the Worker runtime
 * calls it from `fetch()`.
 */
import type { AgentInput } from '../providers/content';
import type { AgentEvent } from '../execution/agentEvents';
import type { SimpleAgent } from '../createAgent';
import { assertSessionId } from '../session/sessionStore';
import type { AgentSession } from '../session/AgentSession';
import { SessionAwaitingApprovalError } from '../execution/errors';
import { errorEvents } from '../cli/devEvents';

/** What the routes need from their host: the live agent and how sessions are opened on it. */
export interface ChatRoutesContext {
  /** Prefix of log lines, e.g. `loushy dev`. */
  name: string;
  /** The live agent; read per request, so a host can swap it (`loushy dev` reloads). */
  agent: () => SimpleAgent;
  /** Opens session `id` on `agent`. Defaults to `agent.session({ id })`. */
  session?: (agent: SimpleAgent, id: string) => AgentSession;
  /** Checkpoints the deprecated `{ message, sessionId }` run under its `sessionId` (needs a checkpoint store on the agent). */
  durableMessage?: boolean;
}

/** Body-size cap for POST routes, matching common Node.js body-size-limit conventions. */
const MAX_BODY_BYTES = 1024 * 1024; // 1MB

class PayloadTooLargeError extends Error {}

async function readBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let bytes = 0;
  // Past the cap the body stops growing but is still drained, so the client
  // can finish writing and the connection does not deadlock; 413 follows.
  for (let chunk = await reader?.read(); chunk && !chunk.done; chunk = await reader?.read()) {
    bytes += chunk.value.byteLength;
    if (bytes <= MAX_BODY_BYTES) body += decoder.decode(chunk.value, { stream: true });
  }
  if (bytes > MAX_BODY_BYTES) throw new PayloadTooLargeError(`Request body exceeds ${MAX_BODY_BYTES} byte limit`);
  return body + decoder.decode();
}

function textResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });
}

function jsonResponse(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const DONE_FRAME = 'event: done\ndata: {}\n\n';
const warnedLegacy = new Set<string>();

/**
 * Streams `events` as SSE (`data: <AgentEvent JSON>`, then `event: done`); a
 * failure becomes `error` + `run.done` events. The turn is aborted when the
 * client goes away (the request's signal, or the response body cancelled).
 */
function sseResponse(request: Request, events: (signal: AbortSignal) => AsyncIterable<AgentEvent>): Response {
  const controller = new AbortController();
  request.signal.addEventListener('abort', () => controller.abort());
  const encoder = new TextEncoder();
  const frame = (event: AgentEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  const iterator = events(controller.signal)[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(out) {
      try {
        const next = await iterator.next();
        if (!next.done) return out.enqueue(frame(next.value));
      } catch (error) {
        errorEvents(error).forEach((event) => out.enqueue(frame(event)));
      }
      out.enqueue(encoder.encode(DONE_FRAME));
      out.close();
    },
    cancel() {
      controller.abort();
      return iterator.return?.().then(() => undefined);
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  return ((JSON.parse((await readBody(request)) || '{}') as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
}

/** The error status for a failed handler: 413 over the size cap, 400 for bad JSON, else 500. */
function failureResponse(error: unknown): Response {
  const status = error instanceof PayloadTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 500;
  return jsonResponse(status, { error: (error as Error).message });
}

/** Session `sessionId` of the live agent, or the 400 response for an invalid id. */
function openSession(ctx: ChatRoutesContext, sessionId: string): AgentSession | Response {
  try {
    assertSessionId(sessionId);
  } catch (error) {
    return jsonResponse(400, { error: (error as Error).message });
  }
  const agent = ctx.agent();
  return ctx.session ? ctx.session(agent, sessionId) : agent.session({ id: sessionId });
}

type RouteHandler = (request: Request, ctx: ChatRoutesContext, params: string[]) => Promise<Response>;

const runChat: RouteHandler = async (request, ctx) => {
  const { sessionId, input, message } = await readJson(request);
  if (typeof sessionId === 'string' && (typeof input === 'string' ? input : Array.isArray(input))) {
    const session = openSession(ctx, sessionId);
    return session instanceof Response ? session : sseResponse(request, (signal) => session.stream(input as AgentInput, { signal }));
  }
  if (typeof message === 'string' && message) {
    if (sessionId !== undefined && typeof sessionId !== 'string') return jsonResponse(400, { error: "Request body's 'sessionId', if present, must be a string" });
    if (!warnedLegacy.has(ctx.name)) console.warn(`[${ctx.name}] POST /chat { message } is deprecated: send { sessionId, input } for a session and a streamed turn.`);
    warnedLegacy.add(ctx.name);
    return jsonResponse(200, await ctx.agent().send(message, ctx.durableMessage && typeof sessionId === 'string' ? { sessionId } : undefined), { Deprecation: 'true' });
  }
  return jsonResponse(400, { error: "Request body must be JSON with 'sessionId' and 'input' strings (or the deprecated 'message')" });
};

/**
 * The approval `id` of a session that paused in another process (or a Worker
 * isolate that is gone): `agent.approvals.list()` only knows pauses of this
 * process, but a checkpointed session names its pending approval, and
 * `resume()` tells the agent which session it belongs to (docs/sessions.md).
 */
async function recoverApproval(session: AgentSession, id: string): Promise<boolean> {
  const turn = await session.pending();
  if (turn?.status !== 'awaiting-approval' || turn.approvalId !== id) return false;
  await session.resume().catch((error) => {
    if (!(error instanceof SessionAwaitingApprovalError)) throw error;
  });
  return true;
}

const runApproval: RouteHandler = async (request, ctx, [sessionId, id]) => {
  const session = openSession(ctx, sessionId);
  if (session instanceof Response) return session;
  const { approved, note, answer } = await readJson(request);
  if (typeof answer !== 'string' && typeof approved !== 'boolean') {
    return jsonResponse(400, { error: "Request body must be JSON with 'approved' (and optional 'note') or 'answer'" });
  }
  const agent = ctx.agent();
  const pending = (await agent.approvals.list()).some((candidate) => candidate.id === id) || (await recoverApproval(session, id));
  if (!pending) {
    return jsonResponse(404, { error: `No pending approval '${id}' (it was decided already, or the agent was reloaded)` });
  }
  // LOU-D32.2: the continuation streams live (decided call, text deltas, a further pause, run.done).
  return sseResponse(request, (signal) =>
    typeof answer === 'string'
      ? agent.approvals.streamAnswer({ id, answer }, { signal })
      : agent.approvals.streamResolve({ id, approved: approved === true, note: typeof note === 'string' ? note : undefined }, { signal })
  );
};

const runTranscript: RouteHandler = async (_request, ctx, [sessionId]) => {
  const session = openSession(ctx, sessionId);
  return session instanceof Response ? session : jsonResponse(200, { sessionId, messages: await session.load(), pending: await session.pending() });
};

/** Routes by method and path; path parameters reach the handler as `params` (already URL-decoded). */
const ROUTES: Array<[method: string, pattern: RegExp, handler: RouteHandler]> = [
  ['POST', /^\/chat$/, runChat],
  ['GET', /^\/chat\/([^/]+)$/, runTranscript],
  ['POST', /^\/chat\/([^/]+)\/approvals\/([^/]+)$/, runApproval],
];

/**
 * Answers `request` when it is one of the `/chat` routes; resolves `undefined`
 * for any other request, so the host can serve its own routes. A failure before
 * streaming starts answers with a JSON error.
 */
export async function handleChatFetch(request: Request, ctx: ChatRoutesContext): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);
  for (const [method, pattern, handler] of ROUTES) {
    const match = method === request.method ? pattern.exec(pathname) : null;
    if (!match) continue;
    try {
      return await handler(request, ctx, match.slice(1).map(decodeURIComponent));
    } catch (error) {
      return failureResponse(error);
    }
  }
  return undefined;
}

const digest = async (value: string): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));

/** Whether `header` is `Bearer <token>`; compared in constant time (both sides hashed to one length first). */
async function hasBearerToken(header: string | null, token: string): Promise<boolean> {
  const presented = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1];
  if (presented === undefined) return false;
  const [a, b] = await Promise.all([digest(presented), digest(token)]);
  return a.reduce((diff, byte, index) => diff | (byte ^ b[index]), 0) === 0;
}

/**
 * The whole deployed API: `GET /health` (open), then, when `token` is set, 401
 * unless the request carries `Authorization: Bearer <token>`, then the `/chat`
 * routes, then 404.
 */
export async function serveFetch(request: Request, ctx: ChatRoutesContext, token?: string): Promise<Response> {
  if (request.method === 'GET' && new URL(request.url).pathname === '/health') return textResponse(200, 'ok');
  if (token && !(await hasBearerToken(request.headers.get('authorization'), token))) {
    return jsonResponse(401, { error: 'Unauthorized: send Authorization: Bearer <token>' }, { 'WWW-Authenticate': 'Bearer' });
  }
  return (await handleChatFetch(request, ctx)) ?? textResponse(404, 'not found');
}
