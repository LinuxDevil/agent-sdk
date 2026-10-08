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
import type { AgentEvent, AgentEventError } from '../execution/agentEvents';
import type { PendingApproval } from '../execution/ApprovalGate';
import { samePrincipal } from '../execution/runPrincipal';
import type { SimpleAgent } from '../createAgent';
import { assertSessionId } from '../session/sessionStore';
import type { AgentSession } from '../session/AgentSession';
import { SessionAwaitingApprovalError } from '../execution/errors';
import { errorEvents } from '../cli/devEvents';
import type { AuthFn, Principal } from '../auth/types';
import { routeAuth } from '../auth/routeAuth';
import { apiToken } from '../auth/basic';
import type { OAuthCompleteResult } from '../oauth/signIn';

/** A1: what a caller wants to do with a session: read its transcript, send it a turn, or decide one of its approvals. */
export type SessionAction = 'read' | 'chat' | 'approve';

/** A1: the input of `authorizeSession`. */
export interface SessionAccessRequest {
  /** The caller route auth accepted; `undefined` on a route without auth. */
  principal: Principal | undefined;
  sessionId: string;
  action: SessionAction;
}

/** A1: the input of `authorizeApproval`. */
export interface ApprovalAccessRequest {
  /** The caller route auth accepted; `undefined` on a route without auth. */
  principal: Principal | undefined;
  /** The session the approval belongs to (the one in the URL). */
  sessionId: string;
  /** The pending approval; `approval.principal` is whose call it is. */
  approval: PendingApproval;
}

/** A1: who may use which session and decide which approval over HTTP, and how much of an error a client sees; B4: what a client disconnect does to a turn. */
export interface ChatRoutesAccess {
  /**
   * Whether `principal` may `action` session `sessionId` (read it, send it a
   * turn, decide one of its approvals). Return `false` for a `403`
   * (`LOUSHO_SESSION_FORBIDDEN`). Default: every caller route auth accepted
   * may use every session, so give sessions ids that cannot be guessed, or
   * check ownership here (docs/auth.md).
   */
  authorizeSession?: (request: SessionAccessRequest) => boolean | Promise<boolean>;
  /**
   * Whether `principal` may decide (approve, reject or answer) `approval`.
   * Return `false` for a `403` (`LOUSHO_APPROVAL_FORBIDDEN`). Default
   * ({@link callerOwnsApproval}): only the caller the paused run acts for, so a
   * user can confirm their own call but not decide another user's. When an
   * approval must come from someone else (a supervisor), say so here, e.g.
   * `({ principal }) => principal?.claims?.role === 'supervisor'`.
   */
  authorizeApproval?: (request: ApprovalAccessRequest) => boolean | Promise<boolean>;
  /**
   * Stream error messages as they are (provider bodies included). Default
   * `false`: an `error` event, a failed request's `500` and a provider
   * retry/fallback event carry the error's `name` and `code` with a generic
   * message, and the full error is logged on the server. `lousho dev` sets it.
   */
  exposeErrors?: boolean;
  /**
   * B4: what happens to a session turn when its client goes away mid-stream
   * (a closed tab, a dropped connection). `'continue'` (default): the turn
   * runs to its end on the server and is saved to the session, so a tool
   * call that already ran (a refund, an email) is in the transcript and the
   * next turn knows about it; nothing more is written to the closed stream.
   * `'abort'`: the turn is aborted, as a `signal` aborts it (tool results it
   * already has are kept).
   */
  onDisconnect?: 'continue' | 'abort';
  /**
   * B4: keeps the host alive for a turn that outlives its client: called
   * with a promise that settles once the turn has finished and been saved.
   * Pass the platform's `waitUntil` on serverless hosts (`ctx.waitUntil` on
   * Cloudflare, `waitUntil` from `@vercel/functions`); a long-running Node
   * server needs none.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * A1: the default `authorizeApproval`: the approval is decided by the caller
 * the paused run acts for (same `id`, `type`, `authenticator` and `issuer`).
 * A run without a principal, or a route without auth, accepts any caller.
 */
export function callerOwnsApproval({ principal, approval }: ApprovalAccessRequest): boolean {
  return approval.principal === undefined || principal === undefined || samePrincipal(principal, approval.principal);
}

/** What the routes need from their host: the live agent and how sessions are opened on it. */
export interface ChatRoutesContext extends ChatRoutesAccess {
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

/** A1: what a client sees of an error unless `exposeErrors` is set. */
const PUBLIC_ERROR_MESSAGE = 'The request failed. The server log has the details.';

function publicError({ name, code }: AgentEventError): AgentEventError {
  return { name, message: PUBLIC_ERROR_MESSAGE, ...(code !== undefined && { code }) };
}

/**
 * A1: `event` as a client may see it: provider error text (response bodies,
 * chat templates) stays in the server log unless the host exposes errors.
 */
function publicEvent(ctx: ChatRoutesContext, event: AgentEvent): AgentEvent {
  if (ctx.exposeErrors) return event;
  if (event.type === 'error') {
    console.error(`[${ctx.name}] run failed:`, event.error);
    return { ...event, error: publicError(event.error) };
  }
  if (event.type === 'provider.retry' || event.type === 'provider.fallback') return { ...event, error: { ...event.error, message: PUBLIC_ERROR_MESSAGE } };
  return event;
}

/** A1: `run` with {@link publicEvent} applied; a failure it throws ends it with the `error` and `run.done` events of a generic error. */
export async function* publicEvents(ctx: ChatRoutesContext, run: AsyncIterable<AgentEvent>): AsyncGenerator<AgentEvent> {
  if (ctx.exposeErrors) return yield* run;
  try {
    for await (const event of run) yield publicEvent(ctx, event);
  } catch (error) {
    for (const event of errorEvents(error)) yield publicEvent(ctx, event);
  }
}
const warnedLegacy = new Set<string>();

/** B4: whether a client disconnect aborts the turn it was streaming (`onDisconnect: 'abort'`). */
export function disconnectAborts(access: ChatRoutesAccess): boolean {
  return access.onDisconnect === 'abort';
}

/**
 * B4: `run` for a client that may go away. When the consumer stops early (the
 * response body is cancelled), `run` is not returned, which would abort the
 * turn: it is read to its end in the background, so the turn finishes and is
 * saved, and that read is handed to `waitUntil`. With `onDisconnect: 'abort'`
 * it is `run` itself.
 */
export function outliveClient(ctx: ChatRoutesAccess & { name: string }, run: AsyncIterable<AgentEvent>): AsyncIterable<AgentEvent> {
  if (disconnectAborts(ctx)) return run;
  return {
    [Symbol.asyncIterator]() {
      const iterator = run[Symbol.asyncIterator]();
      let detached: Promise<void> | undefined;
      const finish = async () => {
        try {
          for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
            if (next.value.type === 'error') console.error(`[${ctx.name}] run failed after its client disconnected:`, next.value.error);
          }
        } catch (error) {
          console.error(`[${ctx.name}] run failed after its client disconnected:`, error);
        }
      };
      return {
        next: () => iterator.next(),
        return: () => {
          if (!detached) {
            detached = finish();
            ctx.waitUntil?.(detached);
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

/**
 * Streams `events` as SSE (`data: <AgentEvent JSON>`, then `event: done`); a
 * failure becomes `error` + `run.done` events. Writing stops when the client
 * goes away (the request's signal, or the response body cancelled); B4: the
 * turn runs on and is saved ({@link outliveClient}), or with `onDisconnect:
 * 'abort'` it is aborted.
 */
function sseResponse(
  request: Request,
  ctx: ChatRoutesContext,
  events: (signal: AbortSignal) => AsyncIterable<AgentEvent>,
  aborter?: AbortController
): Response {
  const aborts = disconnectAborts(ctx);
  const controller = aborter ?? new AbortController();
  if (!aborter && aborts) request.signal.addEventListener('abort', () => controller.abort());
  const encoder = new TextEncoder();
  const frame = (event: AgentEvent) => encoder.encode(`data: ${JSON.stringify(publicEvent(ctx, event))}\n\n`);
  const iterator = outliveClient(ctx, events(controller.signal))[Symbol.asyncIterator]();
  let gone = false;
  const leave = async () => {
    if (gone) return;
    gone = true;
    if (aborts) controller.abort();
    await iterator.return?.();
  };
  if (!aborts) request.signal.addEventListener('abort', () => void leave());
  const body = new ReadableStream<Uint8Array>({
    async pull(out) {
      if (gone) return out.close();
      try {
        const next = await iterator.next();
        if (gone) return;
        if (!next.done) return out.enqueue(frame(next.value));
      } catch (error) {
        if (gone) return;
        errorEvents(error).forEach((event) => out.enqueue(frame(event)));
      }
      out.enqueue(encoder.encode(DONE_FRAME));
      out.close();
    },
    cancel: leave,
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  return ((JSON.parse((await readBody(request)) || '{}') as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
}

/** The error status for a failed handler: 413 over the size cap, 400 for bad JSON, else 500 (A1: its message logged, not sent). */
function failureResponse(ctx: ChatRoutesContext, error: unknown): Response {
  const status = error instanceof PayloadTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 500;
  if (status !== 500 || ctx.exposeErrors) return jsonResponse(status, { error: (error as Error).message });
  console.error(`[${ctx.name}] request failed:`, error);
  const code = (error as { code?: unknown } | null)?.code;
  return jsonResponse(500, { error: PUBLIC_ERROR_MESSAGE, ...(typeof code === 'string' && code && { code }) });
}

const ACTION_WORDS: Record<SessionAction, string> = { read: 'read', chat: 'continue', approve: 'decide approvals of' };

/** A1: the `403` for a caller `authorizeSession` refuses; `undefined` when it may go on. */
export async function sessionForbidden(access: ChatRoutesAccess, principal: Principal | undefined, sessionId: string, action: SessionAction): Promise<Response | undefined> {
  if (!access.authorizeSession || (await access.authorizeSession({ principal, sessionId, action }))) return undefined;
  return jsonResponse(403, { error: `Not allowed to ${ACTION_WORDS[action]} this session`, code: 'LOUSHO_SESSION_FORBIDDEN' });
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
    if (session instanceof Response) return session;
    const forbidden = await sessionForbidden(ctx, principal, sessionId, 'chat');
    return forbidden ?? sseResponse(request, ctx, (signal) => session.stream(input as AgentInput, { signal, principal }));
  }
  if (typeof message === 'string' && message) {
    if (sessionId !== undefined && typeof sessionId !== 'string') return jsonResponse(400, { error: "Request body's 'sessionId', if present, must be a string" });
    const forbidden = typeof sessionId === 'string' ? await sessionForbidden(ctx, principal, sessionId, 'chat') : undefined;
    if (forbidden) return forbidden;
    if (!warnedLegacy.has(ctx.name)) console.warn(`[${ctx.name}] POST /chat { message } is deprecated: send { sessionId, input } for a session and a streamed turn.`);
    warnedLegacy.add(ctx.name);
    return jsonResponse(200, await ctx.agent().send(message, { ...(ctx.durableMessage && typeof sessionId === 'string' && { sessionId }), principal }), { Deprecation: 'true' });
  }
  return jsonResponse(400, { error: "Request body must be JSON with 'sessionId' and 'input' strings (or the deprecated 'message')" });
};

/**
 * A1: the pending approval `id` when it belongs to `session`, else
 * `undefined`. A pause of this process names its session; one made in
 * another process (or a Worker isolate that is gone) is found through the
 * session's checkpoint, which names its pending approval.
 */
async function approvalOf(agent: SimpleAgent, session: AgentSession, id: string): Promise<PendingApproval | undefined> {
  const live = (await agent.approvals.list()).find((candidate) => candidate.id === id);
  if (live) return live.sessionId === session.id ? live : undefined;
  const turn = await session.pending();
  if (turn?.status !== 'awaiting-approval' || turn.approvalId !== id) return undefined;
  // A store without `load()` cannot say whose call it is: the run then counts as having no principal.
  return (await agent.approvals.get(id)) ?? { id, toolCallId: '', toolName: '', args: {}, createdAt: '', sessionId: session.id };
}

/**
 * A pause found through `session`'s checkpoint: `resume()` tells the agent
 * which session it belongs to (docs/sessions.md), so deciding it continues
 * that session.
 */
async function bindRecovered(agent: SimpleAgent, session: AgentSession, id: string): Promise<void> {
  if ((await agent.approvals.list()).some((candidate) => candidate.id === id)) return;
  await session.resume().catch((error) => {
    if (!(error instanceof SessionAwaitingApprovalError)) throw error;
  });
}

function notPending(id: string): Response {
  return jsonResponse(404, { error: `No pending approval '${id}' (it was decided already, or the agent was reloaded)`, code: 'LOUSHO_APPROVAL_NOT_FOUND' });
}

/**
 * Reads a decision's stream up to its first event after `run.start`: a
 * decision that lost the race for the approval (A1) or approves a sign-in the
 * user has not finished (N9b) is a `409`; anything else is replayed in full.
 */
async function decisionGate(run: AsyncIterable<AgentEvent>): Promise<Response | AsyncIterable<AgentEvent>> {
  const iterator = run[Symbol.asyncIterator]();
  const head: AgentEvent[] = [];
  let next = await iterator.next();
  while (!next.done && next.value.type === 'run.start') {
    head.push(next.value);
    next = await iterator.next();
  }
  const first = next.done ? undefined : next.value;
  if (first?.type === 'error' && first.error.code === 'LOUSHO_APPROVAL_NOT_FOUND') {
    await iterator.return?.();
    return jsonResponse(409, { error: 'This approval was decided by another request', code: 'LOUSHO_APPROVAL_CONFLICT' });
  }
  if (first?.type === 'error' && first.error.name === 'SignInPendingError') {
    await iterator.return?.();
    return jsonResponse(409, { error: first.error.message, code: 'LOUSHO_SIGNIN_PENDING' });
  }
  async function* replay(): AsyncGenerator<AgentEvent> {
    yield* head;
    for (let current = next; !current.done; current = await iterator.next()) yield current.value;
  }
  return replay();
}

const runApproval: RouteHandler = async (request, ctx, [sessionId, id], principal) => {
  const session = openSession(ctx, sessionId);
  if (session instanceof Response) return session;
  const { approved, note, answer } = await readJson(request);
  if (typeof answer !== 'string' && typeof approved !== 'boolean') {
    return jsonResponse(400, { error: "Request body must be JSON with 'approved' (and optional 'note') or 'answer'" });
  }
  const forbidden = await sessionForbidden(ctx, principal, sessionId, 'approve');
  if (forbidden) return forbidden;
  const agent = ctx.agent();
  // A1: only an approval of the session in the URL; another session's is as unknown as a decided one.
  const approval = await approvalOf(agent, session, id);
  if (!approval) return notPending(id);
  if (!(await (ctx.authorizeApproval ?? callerOwnsApproval)({ principal, sessionId, approval }))) {
    return jsonResponse(403, { error: 'Not allowed to decide this approval', code: 'LOUSHO_APPROVAL_FORBIDDEN' });
  }
  await bindRecovered(agent, session, id);
  // LOU-D32.2: the continuation streams live (decided call, text deltas, a further pause, run.done).
  // N10b: the caller route auth accepted is the approver (`ctx.approval.by`); the run keeps its own principal.
  const controller = new AbortController();
  // B4: by default the decided call runs to its end even when the client leaves (sseResponse).
  if (disconnectAborts(ctx)) request.signal.addEventListener('abort', () => controller.abort());
  const run =
    typeof answer === 'string'
      ? agent.approvals.streamAnswer({ id, answer }, { signal: controller.signal, principal })
      : agent.approvals.streamResolve({ id, approved: approved === true, note: typeof note === 'string' ? note : undefined }, { signal: controller.signal, principal });
  const gate = await decisionGate(run);
  return gate instanceof Response ? gate : sseResponse(request, ctx, () => gate, controller);
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

const runTranscript: RouteHandler = async (_request, ctx, [sessionId], principal) => {
  const session = openSession(ctx, sessionId);
  if (session instanceof Response) return session;
  return (await sessionForbidden(ctx, principal, sessionId, 'read')) ?? jsonResponse(200, { sessionId, messages: await session.load(), pending: await session.pending() });
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
      return failureResponse(ctx, error);
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
