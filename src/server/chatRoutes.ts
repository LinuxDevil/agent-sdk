/**
 * The `/chat` HTTP API of `loushy dev` and of the deployed node server (LOU-D32, LOU-D14):
 *
 *   POST /chat                           { sessionId, input } in, the turn streamed as SSE out
 *                                        (`data: <AgentEvent>` frames, then `event: done`);
 *                                        the deprecated { message } still returns the ExecutionResult
 *   GET  /chat/:sessionId                the session's transcript and pending approvals
 *   POST /chat/:sessionId/approvals/:id  { approved, note? } or { answer }, the continuation streamed
 *
 * Framework-free: handlers take a plain `(req, res)` pair from `node:http`, and
 * this module has no runtime `node:*` import (the node types are type-only),
 * so a Worker adapter can reuse the routing and event logic later. Node-only
 * parts (bearer auth) live in their own files.
 */
import type * as http from 'node:http';
import type { AgentInput } from '../providers/content';
import type { AgentEvent } from '../execution/agentEvents';
import type { SimpleAgent } from '../createAgent';
import { assertSessionId } from '../session/sessionStore';
import type { AgentSession } from '../session/AgentSession';
import { continuationEvents, errorEvents } from '../cli/devEvents';

/** What the routes need from their host: the live agent and how sessions are opened on it. */
export interface ChatRoutesContext {
  /** Prefix of log lines, e.g. `loushy dev`. */
  name: string;
  /** The live agent; read per request, so a host can swap it (`loushy dev` reloads). */
  agent: () => SimpleAgent;
  /** Opens session `id` on `agent`. Defaults to `agent.session({ id })`. */
  session?: (agent: SimpleAgent, id: string) => AgentSession;
}

/** Body-size cap for POST routes, matching common Node.js body-size-limit conventions. */
const MAX_BODY_BYTES = 1024 * 1024; // 1MB

class PayloadTooLargeError extends Error {}

/**
 * The request body's exact bytes (signatures are checked over these), at
 * most 1MB: a larger body rejects with an error `sendFailure()` answers with
 * 413. Shared with the channel handler (src/channels/mountChannels.ts).
 */
export function readRawBody(req: http.IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    req.on('data', (chunk: Uint8Array | string) => {
      const data = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      bytes += data.length;
      // Over the cap: stop keeping chunks, but keep draining the stream
      // (rather than destroying it or dropping listeners) so the client can
      // finish writing and the connection doesn't deadlock - we reject once
      // the request actually ends.
      if (bytes <= MAX_BODY_BYTES) chunks.push(data);
    });
    req.on('end', () => {
      if (bytes > MAX_BODY_BYTES) {
        reject(new PayloadTooLargeError(`Request body exceeds ${MAX_BODY_BYTES} byte limit`));
        return;
      }
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(body);
    });
    req.on('error', reject);
  });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new TextDecoder().decode(await readRawBody(req));
}

export function sendText(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(text);
}

export function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

const DONE_FRAME = 'event: done\ndata: {}\n\n';
const warnedLegacy = new Set<string>();

/** Streams `events` as SSE (`data: <AgentEvent JSON>`, then `event: done`); a failure becomes `error` + `run.done` events. */
async function sendSse(res: http.ServerResponse, events: (signal: AbortSignal) => AsyncIterable<AgentEvent>): Promise<void> {
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const write = (event: AgentEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  try {
    for await (const event of events(controller.signal)) write(event);
  } catch (error) {
    errorEvents(error).forEach(write);
  }
  res.end(DONE_FRAME);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return ((JSON.parse((await readBody(req)) || '{}') as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
}

/** Sends the error status for a failed handler: 413 over the size cap, 400 for bad JSON, else 500. */
export function sendFailure(res: http.ServerResponse, error: unknown): void {
  const status = error instanceof PayloadTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 500;
  sendJson(res, status, { error: (error as Error).message });
}

/** Session `sessionId` of the live agent; sends 400 and returns undefined for an invalid id. */
function openSession(res: http.ServerResponse, ctx: ChatRoutesContext, sessionId: string): AgentSession | undefined {
  try {
    assertSessionId(sessionId);
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message });
    return undefined;
  }
  const agent = ctx.agent();
  return ctx.session ? ctx.session(agent, sessionId) : agent.session({ id: sessionId });
}

type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse, ctx: ChatRoutesContext, params: string[]) => Promise<void>;

async function runChat(req: http.IncomingMessage, res: http.ServerResponse, ctx: ChatRoutesContext): Promise<void> {
  const { sessionId, input, message } = await readJson(req);
  if (typeof sessionId === 'string' && (typeof input === 'string' ? input : Array.isArray(input))) {
    const session = openSession(res, ctx, sessionId);
    if (session) await sendSse(res, (signal) => session.stream(input as AgentInput, { signal }));
    return;
  }
  if (typeof message === 'string' && message) {
    if (!warnedLegacy.has(ctx.name)) console.warn(`[${ctx.name}] POST /chat { message } is deprecated: send { sessionId, input } for a session and a streamed turn.`);
    warnedLegacy.add(ctx.name);
    res.setHeader('Deprecation', 'true');
    sendJson(res, 200, await ctx.agent().send(message));
    return;
  }
  sendJson(res, 400, { error: "Request body must be JSON with 'sessionId' and 'input' strings (or the deprecated 'message')" });
}

async function runApproval(req: http.IncomingMessage, res: http.ServerResponse, ctx: ChatRoutesContext, [sessionId, id]: string[]): Promise<void> {
  if (!openSession(res, ctx, sessionId)) return;
  const { approved, note, answer } = await readJson(req);
  if (typeof answer !== 'string' && typeof approved !== 'boolean') {
    sendJson(res, 400, { error: "Request body must be JSON with 'approved' (and optional 'note') or 'answer'" });
    return;
  }
  const agent = ctx.agent();
  const request = (await agent.approvals.list()).find((pending) => pending.id === id);
  if (!request) {
    sendJson(res, 404, { error: `No pending approval '${id}' (it was decided already, or the agent was reloaded)` });
    return;
  }
  await sendSse(res, async function* (signal) {
    const result =
      typeof answer === 'string'
        ? await agent.approvals.answer({ id, answer }, { signal })
        : await agent.approvals.resolve({ id, approved: approved === true, note: typeof note === 'string' ? note : undefined }, { signal });
    const pausedAgain = (await agent.approvals.list()).find((pending) => pending.id === result.approvalId);
    yield* continuationEvents(result, request, pausedAgain);
  });
}

async function runTranscript(_req: http.IncomingMessage, res: http.ServerResponse, ctx: ChatRoutesContext, [sessionId]: string[]): Promise<void> {
  const session = openSession(res, ctx, sessionId);
  if (session) sendJson(res, 200, { sessionId, messages: await session.load(), pending: await session.pending() });
}

/** Routes by method and path; path parameters reach the handler as `params` (already URL-decoded). */
const ROUTES: Array<[method: string, pattern: RegExp, handler: RouteHandler]> = [
  ['POST', /^\/chat$/, runChat],
  ['GET', /^\/chat\/([^/]+)$/, runTranscript],
  ['POST', /^\/chat\/([^/]+)\/approvals\/([^/]+)$/, runApproval],
];

/**
 * Handles `req` when it is one of the `/chat` routes and resolves `true`; resolves
 * `false` (nothing written) for any other request, so the host can serve its own
 * routes. A failure before streaming starts answers with a JSON error.
 */
export async function handleChatRequest(req: http.IncomingMessage, res: http.ServerResponse, ctx: ChatRoutesContext): Promise<boolean> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  for (const [method, pattern, handler] of ROUTES) {
    const match = method === req.method ? pattern.exec(pathname) : null;
    if (!match) continue;
    try {
      await handler(req, res, ctx, match.slice(1).map(decodeURIComponent));
    } catch (error) {
      sendFailure(res, error);
    }
    return true;
  }
  return false;
}
