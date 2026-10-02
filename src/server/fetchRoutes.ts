/**
 * The `/chat` HTTP API of `lousho dev`, of the deployed node server and of the
 * Cloudflare Worker (LOU-D32, LOU-D14, LOU-D51), written once on the Fetch API:
 *
 *   GET  /health                         `ok`, never behind the bearer token
 *   POST /chat                           { sessionId, input } in, the turn streamed as SSE out
 *                                        (`data: <AgentEvent>` frames, then `event: done`);
 *                                        the deprecated { message } still returns the ExecutionResult
 *   GET  /chat/:sessionId                the session's transcript and pending approvals
 *   POST /chat/:sessionId/approvals/:id  { approved, note? } or { answer }, the continuation streamed
 *                                        (409 for a sign-in pause the user has not signed in to yet)
 *   GET  /oauth/callback                 N9b: where an OAuth provider redirects after sign-in; never behind
 *                                        the bearer token (its protection is the single-use `state`)
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
import type { AuthFn, Principal } from '../auth/types';
import { routeAuth } from '../auth/routeAuth';
import { apiToken } from '../auth/basic';
import type { OAuthCompleteResult } from '../oauth/signIn';
import { awaitSignInGate } from '../oauth/signInPending';

/** What the routes need from their host: the live agent and how sessions are opened on it. */
export interface ChatRoutesContext {
  /** Prefix of log lines, e.g. `lousho dev`. */
  name: string;
  /** The live agent; read per request, so a host can swap it (`lousho dev` reloads). */
  agent: () => SimpleAgent;
  /** Opens session `id` on `agent`. Defaults to `agent.session({ id })`. */
  session?: (agent: SimpleAgent, id: string) => AgentSession;
  /** Checkpoints the deprecated `{ message, sessionId }` run under its `sessionId` (needs a checkpoint store on the agent). */
  durableMessage?: boolean;
  /**
   * N9b: called after `GET /oauth/callback` stored a token (or the user
   * declined), e.g. to continue a channel turn that paused on that sign-in.
   * Not awaited by the response.
   */
  afterSignIn?: (result: OAuthCompleteResult) => void;
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
function sseResponse(request: Request, events: (signal: AbortSignal) => AsyncIterable<AgentEvent>, aborter?: AbortController): Response {
  const controller = aborter ?? new AbortController();
  if (!aborter) request.signal.addEventListener('abort', () => controller.abort());
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

type RouteHandler = (request: Request, ctx: ChatRoutesContext, params: string[], principal: Principal | undefined) => Promise<Response>;

const runChat: RouteHandler = async (request, ctx, _params, principal) => {
  const { sessionId, input, message } = await readJson(request);
  if (typeof sessionId === 'string' && (typeof input === 'string' ? input : Array.isArray(input))) {
    const session = openSession(ctx, sessionId);
    return session instanceof Response ? session : sseResponse(request, (signal) => session.stream(input as AgentInput, { signal, principal }));
  }
  if (typeof message === 'string' && message) {
    if (sessionId !== undefined && typeof sessionId !== 'string') return jsonResponse(400, { error: "Request body's 'sessionId', if present, must be a string" });
    if (!warnedLegacy.has(ctx.name)) console.warn(`[${ctx.name}] POST /chat { message } is deprecated: send { sessionId, input } for a session and a streamed turn.`);
    warnedLegacy.add(ctx.name);
    return jsonResponse(200, await ctx.agent().send(message, { ...(ctx.durableMessage && typeof sessionId === 'string' && { sessionId }), principal }), { Deprecation: 'true' });
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

const runApproval: RouteHandler = async (request, ctx, [sessionId, id], principal) => {
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
  // N10b: the caller route auth accepted is the approver (`ctx.approval.by`); the run keeps its own principal.
  const controller = new AbortController();
  request.signal.addEventListener('abort', () => controller.abort());
  const run =
    typeof answer === 'string'
      ? agent.approvals.streamAnswer({ id, answer }, { signal: controller.signal, principal })
      : agent.approvals.streamResolve({ id, approved: approved === true, note: typeof note === 'string' ? note : undefined }, { signal: controller.signal, principal });
  // N9b: approving a sign-in pause before the user signed in leaves it paused: 409, not a failed stream.
  const gate = await awaitSignInGate(run);
  if (gate.pending) return jsonResponse(409, { error: gate.message, code: 'LOUSHO_SIGNIN_PENDING' });
  return sseResponse(request, () => gate.events, controller);
};

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** The small page the browser lands on after a sign-in: no script, every value escaped, never cached. */
function signInPage(status: number, title: string, text: string): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body><p>${escapeHtml(text)}</p></body></html>`;
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' },
  });
}

/**
 * N9b: `GET /oauth/callback?state&code` (or `&error`): finishes the sign-in
 * with `agent.oauth.complete()` and answers a small HTML page. An unknown,
 * used or expired `state` is 400. The page never shows a query value.
 */
const runOAuthCallback: RouteHandler = async (request, ctx, _params, principal) => {
  const query = new URL(request.url).searchParams;
  const code = query.get('code');
  const error = query.get('error');
  try {
    const result = await ctx.agent().oauth.complete({
      state: query.get('state') ?? '',
      ...(code !== null && { code }),
      ...(error !== null && { error }),
      ...(principal && { principal }),
    });
    ctx.afterSignIn?.(result);
    const name = result.displayName ?? result.provider;
    return result.outcome === 'signed-in'
      ? signInPage(200, 'Signed in', `Signed in to ${name}. You can close this tab.`)
      : signInPage(200, 'Sign-in cancelled', `Sign-in to ${name} was cancelled. You can close this tab.`);
  } catch (failure) {
    const failed = (failure as { code?: unknown } | null)?.code;
    if (failed === 'LOUSHO_OAUTH_STATE_INVALID') return signInPage(400, 'Sign-in failed', 'This sign-in link is invalid, was already used, or expired. Start again from the app.');
    if (failed === 'LOUSHO_OAUTH_TOKEN_EXCHANGE_FAILED') return signInPage(502, 'Sign-in failed', 'The sign-in could not be completed. Start again from the app.');
    console.error(`[${ctx.name}] OAuth callback failed:`, (failure as Error | null)?.message ?? failure);
    return signInPage(500, 'Sign-in failed', 'The sign-in could not be completed. Start again from the app.');
  }
};

const runTranscript: RouteHandler = async (_request, ctx, [sessionId]) => {
  const session = openSession(ctx, sessionId);
  return session instanceof Response ? session : jsonResponse(200, { sessionId, messages: await session.load(), pending: await session.pending() });
};

/** N9b: the sign-in callback, under any prefix (a proxy may mount the API below a path). */
const OAUTH_CALLBACK = /^(?:\/.*)?\/oauth\/callback$/;

/** Whether `request` is the OAuth callback: a browser redirect, so it carries no API token. */
function isOAuthCallback(request: Request): boolean {
  return request.method === 'GET' && OAUTH_CALLBACK.test(new URL(request.url).pathname);
}

/**
 * N9b: who is completing a sign-in, when the callback request happens to be
 * authenticated (e.g. a session cookie the auth list accepts); `undefined`
 * otherwise. Never a refusal: the callback is open, its `state` protects it.
 * An anonymous principal says nothing about the user, so it is not used.
 */
export async function callbackPrincipal(request: Request, auth: readonly AuthFn[] | AuthFn | undefined): Promise<Principal | undefined> {
  if (auth === undefined) return undefined;
  const outcome = await routeAuth(request, auth);
  return outcome.ok && outcome.principal.authenticator !== 'anonymous' ? outcome.principal : undefined;
}

/** Routes by method and path; path parameters reach the handler as `params` (already URL-decoded). */
const ROUTES: Array<[method: string, pattern: RegExp, handler: RouteHandler]> = [
  ['POST', /^\/chat$/, runChat],
  ['GET', /^\/chat\/([^/]+)$/, runTranscript],
  ['POST', /^\/chat\/([^/]+)\/approvals\/([^/]+)$/, runApproval],
  ['GET', OAUTH_CALLBACK, runOAuthCallback],
];

/**
 * Answers `request` when it is one of the `/chat` routes; resolves `undefined`
 * for any other request, so the host can serve its own routes. A failure before
 * streaming starts answers with a JSON error. `principal` (N10a) is the caller
 * the host's auth accepted; a new turn runs with it, and (N10b) a decision on
 * an approval records it as the approver.
 */
export async function handleChatFetch(request: Request, ctx: ChatRoutesContext, principal?: Principal): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);
  for (const [method, pattern, handler] of ROUTES) {
    const match = method === request.method ? pattern.exec(pathname) : null;
    if (!match) continue;
    try {
      return await handler(request, ctx, match.slice(1).map(decodeURIComponent), principal);
    } catch (error) {
      return failureResponse(error);
    }
  }
  return undefined;
}

/** What guards the deployed API: a bearer token (`LOUSHO_API_TOKEN`), or (N10a) an auth entry or ordered list (docs/auth.md). */
export type ServeAuth = string | AuthFn | readonly AuthFn[];

/**
 * The whole deployed API: `GET /health` (open), then, when `auth` is set, the
 * auth check (a token string is `apiToken(token)`; a 401 / 403 / 500 is
 * answered here), then the `/chat` routes with the accepted principal, then 404.
 */
export async function serveFetch(request: Request, ctx: ChatRoutesContext, auth?: ServeAuth): Promise<Response> {
  if (request.method === 'GET' && new URL(request.url).pathname === '/health') return textResponse(200, 'ok');
  let principal: Principal | undefined;
  if (isOAuthCallback(request)) {
    // N9b: a browser redirect carries no API token; an authenticated one still names who completes the sign-in.
    principal = typeof auth === 'string' ? undefined : await callbackPrincipal(request, auth);
  } else if (auth !== undefined && auth !== '') {
    const outcome = await routeAuth(request, typeof auth === 'string' ? apiToken(auth) : auth);
    if (!outcome.ok) return outcome.response;
    principal = outcome.principal;
  }
  return (await handleChatFetch(request, ctx, principal)) ?? textResponse(404, 'not found');
}
