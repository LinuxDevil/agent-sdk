/**
 * LOU-P4: serve an agent from a route file of any framework that exports Fetch
 * handlers (Next.js App Router, SvelteKit `+server.ts`, Remix, Hono, Bun.serve).
 * A thin wrapper over the deployed session API (fetchRoutes.ts): it strips the
 * mount path, checks auth, and adds the optional `useChat` endpoint. `Request`
 * in, `Response` out; no framework and no `node:*` import.
 */
import type { SimpleAgent } from '../createAgent';
import { newId } from '../utils/id';
import { callbackPrincipal, handleChatFetch } from './fetchRoutes';
import { AuthError, type AuthFn, type Principal } from '../auth/types';
import { routeAuth } from '../auth/routeAuth';
import { apiToken } from '../auth/basic';
import { fromUIMessages, toUIMessageStreamResponse, type UIMessageLike } from './uiMessageStream';

/** A Fetch handler: what a route file exports as `GET` / `POST`. */
export type RouteHandler = (request: Request) => Promise<Response>;

export interface RouteHandlerOptions {
  /** Where the route is mounted, without a trailing slash. Default `/api/agent` (for `app/api/agent/[[...path]]/route.ts`). */
  basePath?: string;
  /**
   * Who may call (docs/auth.md): an ordered list of auth entries from
   * `@lousho/build-ai-agent/auth` (`jwt()`, `oidc()`, `basic()`, `apiToken()`, ...)
   * or one entry; the accepted `principal` reaches the run. Also a bearer token
   * string (`apiToken(token)`), or a function returning a boolean (`true`
   * accepts with principal `{ id: 'anonymous', type: 'user', authenticator: 'custom' }`).
   * Default: nobody is checked, so a public route needs one.
   */
  auth?: string | ((request: Request) => boolean | Promise<boolean>) | AuthFn | readonly AuthFn[];
  /** Adds `POST <basePath>/ui`, the endpoint the AI SDK's `useChat` posts to (docs/ai-sdk-ui.md). */
  uiMessageStream?: boolean;
}

export interface RouteHandlers {
  GET: RouteHandler;
  POST: RouteHandler;
  /** The same handler, for hosts that route every method to one function (Hono, Bun.serve). */
  handler: RouteHandler;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const text = (status: number, body: string) => new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });

/** `/api/agent/chat/` under `/api/agent` is `/chat`; paths outside the base path are `undefined`. */
function stripBase(pathname: string, base: string): string | undefined {
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return undefined;
  return pathname.slice(base.length).replace(/\/+$/, '') || '/';
}

/** A function given as `auth`: a boolean answer keeps its pre-N10a meaning, anything else is an `AuthFn` result. */
function singleFunction(fn: (request: Request) => unknown): AuthFn {
  const entry: AuthFn = async (request) => {
    const result = await fn(request);
    if (result === true) return { id: 'anonymous', type: 'user', authenticator: 'custom' };
    if (result === false) throw new AuthError(401);
    return result as Principal | null | undefined;
  };
  const { challenges } = fn as AuthFn;
  if (challenges) entry.challenges = challenges;
  return entry;
}

/** The `auth` option as an auth list; `undefined` for an open route. */
function authList(auth: RouteHandlerOptions['auth']): readonly AuthFn[] | undefined {
  if (auth === undefined) return undefined;
  if (typeof auth === 'string') return auth === '' ? [] : [apiToken(auth)];
  if (typeof auth === 'function') return [singleFunction(auth)];
  return auth;
}

let warnedOpen = false;

/** One warning per process when a route is served with no `auth` in production. */
function warnOpenInProduction(): void {
  if (warnedOpen || typeof process === 'undefined' || process.env?.NODE_ENV !== 'production') return;
  warnedOpen = true;
  console.warn('[lousho] createRouteHandler() has no `auth`: anyone who can reach this route can use the agent. See docs/auth.md.');
}

async function uiChat(agent: SimpleAgent, request: Request, principal: Principal | undefined): Promise<Response> {
  const body = (await request.json().catch(() => undefined)) as { messages?: UIMessageLike[]; id?: unknown } | undefined;
  if (!Array.isArray(body?.messages)) return json(400, { error: "Request body must be JSON with a 'messages' array" });
  const { id } = body;
  if (typeof id !== 'string' || !id) return toUIMessageStreamResponse(agent.stream(fromUIMessages(body.messages), { principal }));
  const input = fromUIMessages(body.messages, { lastUserOnly: true });
  return toUIMessageStreamResponse(agent.session({ id }).stream(input, { signal: request.signal, principal }));
}

/**
 * The routes `useLoushoAgent({ url, approvalsUrl })` talks to, mapped onto the
 * session API: `POST <base>` takes `{ input, sessionId? }` (a fresh session when
 * none is sent) and `POST <base>/approvals/:id` decides a pending approval.
 */
async function hookRoute(request: Request, path: string): Promise<{ path: string; body?: string }> {
  const approval = /^\/approvals\/([^/]+)$/.exec(path);
  if (approval) return { path: `/chat/hook/approvals/${approval[1]}` };
  if (path !== '/') return { path };
  const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  return { path: '/chat', body: JSON.stringify({ ...body, sessionId: body.sessionId ?? newId() }) };
}

/**
 * Serves `agent` (the session API of `lousho dev` and the deployed server:
 * `POST /chat`, `GET /chat/:id`, approvals, `GET /health`, and - N9b - the
 * OAuth sign-in callback `GET <basePath>/oauth/callback`, which is not behind
 * `auth`) under `basePath`;
 * `POST <basePath>` and `POST <basePath>/approvals/:id` serve `useLoushoAgent`.
 *
 * @example
 * ```ts
 * // app/api/agent/[[...path]]/route.ts
 * export const { GET, POST } = createRouteHandler(agent, { basePath: '/api/agent', auth: process.env.AGENT_TOKEN });
 * ```
 */
export function createRouteHandler(agent: SimpleAgent, options: RouteHandlerOptions = {}): RouteHandlers {
  const base = (options.basePath ?? '/api/agent').replace(/\/+$/, '');
  const ctx = { name: 'route', agent: () => agent };
  const auth = authList(options.auth);
  if (!auth) warnOpenInProduction();
  const handler: RouteHandler = async (request) => {
    const url = new URL(request.url);
    const path = stripBase(url.pathname, base);
    if (path === undefined) return text(404, 'not found');
    if (request.method === 'GET' && path === '/health') return text(200, 'ok');
    let principal: Principal | undefined;
    if (request.method === 'GET' && path === '/oauth/callback') {
      // N9b: the provider's redirect carries no API token; the single-use `state` protects it.
      principal = await callbackPrincipal(request, auth);
    } else if (auth) {
      const outcome = await routeAuth(request, auth);
      if (!outcome.ok) return outcome.response;
      principal = outcome.principal;
    }
    if (options.uiMessageStream && request.method === 'POST' && path === '/ui') {
      return uiChat(agent, request, principal).catch((error) => json(500, { error: (error as Error).message }));
    }
    const routed = request.method === 'POST' ? await hookRoute(request.clone(), path) : { path };
    url.pathname = routed.path;
    const forwarded = routed.body === undefined ? new Request(url, request) : new Request(url, { method: 'POST', headers: request.headers, body: routed.body });
    return (await handleChatFetch(forwarded, ctx, principal)) ?? text(404, 'not found');
  };
  return { GET: handler, POST: handler, handler };
}
