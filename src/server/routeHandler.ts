/**
 * LOU-P4: serve an agent from a route file of any framework that exports Fetch
 * handlers (Next.js App Router, SvelteKit `+server.ts`, Remix, Hono, Bun.serve).
 * A thin wrapper over the deployed session API (fetchRoutes.ts): it strips the
 * mount path, checks auth, and adds the optional `useChat` endpoint. `Request`
 * in, `Response` out; no framework and no `node:*` import.
 */
import type { SimpleAgent } from '../createAgent';
import { newId } from '../utils/id';
import { handleChatFetch, hasBearerToken } from './fetchRoutes';
import { fromUIMessages, toUIMessageStreamResponse, type UIMessageLike } from './uiMessageStream';

/** A Fetch handler: what a route file exports as `GET` / `POST`. */
export type RouteHandler = (request: Request) => Promise<Response>;

export interface RouteHandlerOptions {
  /** Where the route is mounted, without a trailing slash. Default `/api/agent` (for `app/api/agent/[[...path]]/route.ts`). */
  basePath?: string;
  /**
   * Who may call: a bearer token (`Authorization: Bearer <token>`) or a function
   * that decides per request. Default: nobody is checked, so a public route needs one.
   */
  auth?: string | ((request: Request) => boolean | Promise<boolean>);
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

async function authorized(request: Request, auth: RouteHandlerOptions['auth']): Promise<boolean> {
  if (auth === undefined) return true;
  if (typeof auth === 'function') return auth(request);
  return hasBearerToken(request.headers.get('authorization'), auth);
}

async function uiChat(agent: SimpleAgent, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => undefined)) as { messages?: UIMessageLike[]; id?: unknown } | undefined;
  if (!Array.isArray(body?.messages)) return json(400, { error: "Request body must be JSON with a 'messages' array" });
  const { id } = body;
  if (typeof id !== 'string' || !id) return toUIMessageStreamResponse(agent.stream(fromUIMessages(body.messages)));
  const input = fromUIMessages(body.messages, { lastUserOnly: true });
  return toUIMessageStreamResponse(agent.session({ id }).stream(input, { signal: request.signal }));
}

/**
 * The routes `useLoushyAgent({ url, approvalsUrl })` talks to, mapped onto the
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
 * Serves `agent` (the session API of `loushy dev` and the deployed server:
 * `POST /chat`, `GET /chat/:id`, approvals, `GET /health`) under `basePath`;
 * `POST <basePath>` and `POST <basePath>/approvals/:id` serve `useLoushyAgent`.
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
  const handler: RouteHandler = async (request) => {
    const url = new URL(request.url);
    const path = stripBase(url.pathname, base);
    if (path === undefined) return text(404, 'not found');
    if (request.method === 'GET' && path === '/health') return text(200, 'ok');
    if (!(await authorized(request, options.auth))) return json(401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    if (options.uiMessageStream && request.method === 'POST' && path === '/ui') {
      return uiChat(agent, request).catch((error) => json(500, { error: (error as Error).message }));
    }
    const routed = request.method === 'POST' ? await hookRoute(request.clone(), path) : { path };
    url.pathname = routed.path;
    const forwarded = routed.body === undefined ? new Request(url, request) : new Request(url, { method: 'POST', headers: request.headers, body: routed.body });
    return (await handleChatFetch(forwarded, ctx)) ?? text(404, 'not found');
  };
  return { GET: handler, POST: handler, handler };
}
