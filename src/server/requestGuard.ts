/**
 * Request checks of the session routes that run before a handler: which
 * `Host` may reach them, that a browser request is not cross-site (CSRF, e.g.
 * with cookie-based auth), and that a POST body is JSON. Fetch-native, no
 * `node:*` import (bundled into Workers).
 */
import type { Principal } from '../auth/types';
import { samePrincipal } from '../execution/runPrincipal';
import { hostHeaderAllowed, hostnameOf } from './hostCheck';

/** What the guards read from the route options. */
export interface RequestGuardOptions {
  allowedHosts?: readonly string[];
  allowedOrigins?: readonly string[];
  requireJsonBody?: boolean;
}

function refusal(status: number, error: string, code: string): Response {
  return new Response(JSON.stringify({ error, code }), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The `host` (name and port) of an `Origin` header value, lowercased; `undefined` for `null` or anything that does not parse. */
function originHost(origin: string): string | undefined {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.host.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** The hosts this request was sent to: its `Host` header (or URL), and `X-Forwarded-Host` set by a proxy in front. */
function requestHosts(request: Request): string[] {
  const forwarded = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  return [request.headers.get('host') ?? new URL(request.url).host, ...(forwarded ? [forwarded] : [])].map((host) => host.toLowerCase());
}

/**
 * Whether a state-changing request comes from another site: an `Origin` that
 * is not this server's own and not in `allowedOrigins`, or `Sec-Fetch-Site:
 * cross-site` without such an `Origin`. A request without either header (curl,
 * a server) is not a browser's cross-site request.
 */
function crossSite(request: Request, allowedOrigins: readonly string[] | undefined): boolean {
  if (allowedOrigins?.includes('*')) return false;
  const origin = request.headers.get('origin');
  if (origin !== null) {
    if (allowedOrigins?.some((allowed) => allowed.toLowerCase() === origin.toLowerCase())) return false;
    const host = originHost(origin);
    return host === undefined || !requestHosts(request).includes(host);
  }
  return request.headers.get('sec-fetch-site') === 'cross-site';
}

/** Whether the `Content-Type` is JSON (`application/json`, or a `+json` type), parameters aside. */
function isJson(request: Request): boolean {
  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  return type === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(type);
}

/**
 * The `403` for a `Host` outside `allowedHosts` (when set). Read for every
 * route but `/health` (and the OAuth callback, which is reached from the
 * provider's redirect); `undefined` when the request may go on.
 */
export function hostRefusal(request: Request, options: RequestGuardOptions): Response | undefined {
  if (options.allowedHosts === undefined) return undefined;
  const host = request.headers.get('host') ?? new URL(request.url).host;
  if (hostHeaderAllowed(host, '', options.allowedHosts)) return undefined;
  return refusal(403, `Host "${hostnameOf(host) ?? host}" is not allowed. Add it to allowedHosts.`, 'LOUSHO_REQUEST_FORBIDDEN');
}

/**
 * The refusal of a POST to a session route that a web page on another site
 * could have sent (`403 LOUSHO_REQUEST_FORBIDDEN`), or whose body is not JSON
 * (`415 LOUSHO_UNSUPPORTED_MEDIA_TYPE`: a form or `text/plain` body is what a
 * cross-site page can send without a CORS preflight); `undefined` when it may
 * go on.
 */
export function postRefusal(request: Request, options: RequestGuardOptions): Response | undefined {
  if (crossSite(request, options.allowedOrigins)) {
    return refusal(403, 'Cross-site request refused. Add the calling page\'s origin to allowedOrigins.', 'LOUSHO_REQUEST_FORBIDDEN');
  }
  if (options.requireJsonBody !== false && !isJson(request)) {
    return refusal(415, "Request body must be JSON: send 'Content-Type: application/json'.", 'LOUSHO_UNSUPPORTED_MEDIA_TYPE');
  }
  return undefined;
}

/** Per agent: each session id and the principal that first used it. */
const owners = new WeakMap<object, Map<string, Principal>>();

/**
 * The default `authorizeSession` once route auth accepted a caller: a session
 * belongs to the first principal that uses it, and any other principal is
 * refused. Kept in memory per agent (so per process, or per Worker isolate):
 * a restart or another replica forgets who owned which session.
 */
export function firstCallerOwns(agent: object, principal: Principal | undefined, sessionId: string): boolean {
  if (principal === undefined) return true;
  let sessions = owners.get(agent);
  if (!sessions) owners.set(agent, (sessions = new Map()));
  const owner = sessions.get(sessionId);
  if (owner === undefined) {
    sessions.set(sessionId, principal);
    return true;
  }
  return samePrincipal(owner, principal);
}
