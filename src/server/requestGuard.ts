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

/** Environment variables of the generated servers (node-server, Cloudflare Worker) that set {@link RequestGuardOptions}. */
const REQUEST_GUARD_ENV = {
  allowedOrigins: 'LOUSHO_ALLOWED_ORIGINS',
  allowedHosts: 'LOUSHO_ALLOWED_HOSTS',
  requireJsonBody: 'LOUSHO_REQUIRE_JSON_BODY',
} as const;

/** A comma-separated list variable, or `undefined` when it is unset or empty. */
function listVar(value: unknown): string[] | undefined {
  const entries = typeof value === 'string' ? value.split(',').map((entry) => entry.trim()).filter(Boolean) : [];
  return entries.length > 0 ? entries : undefined;
}

/**
 * The {@link RequestGuardOptions} the environment sets (`env` is
 * `process.env`, or a Worker's bindings): `LOUSHO_ALLOWED_ORIGINS` and
 * `LOUSHO_ALLOWED_HOSTS` (comma-separated), and `LOUSHO_REQUIRE_JSON_BODY`
 * (`"false"` turns the JSON check off). Unset ones are left out.
 */
export function requestGuardFromEnv(env: Record<string, unknown>): RequestGuardOptions {
  const allowedOrigins = listVar(env[REQUEST_GUARD_ENV.allowedOrigins]);
  const allowedHosts = listVar(env[REQUEST_GUARD_ENV.allowedHosts]);
  const json = env[REQUEST_GUARD_ENV.requireJsonBody];
  const requireJsonBody = typeof json === 'string' && /^(false|0|no)$/i.test(json.trim()) ? false : undefined;
  return { ...(allowedOrigins && { allowedOrigins }), ...(allowedHosts && { allowedHosts }), ...(requireJsonBody === false && { requireJsonBody }) };
}

/**
 * `decodeURIComponent` for a route parameter, translating malformed
 * percent-encoding into a `SyntaxError`: the failure mappers of the session
 * routes and channel mounts answer a `SyntaxError` with 400, where a
 * `URIError` (`%zz`) would be reported as a 500.
 */
export function decodeParam(param: string): string {
  try {
    return decodeURIComponent(param);
  } catch (error) {
    throw new SyntaxError(`Malformed percent-encoding in the request path: ${(error as Error).message}`);
  }
}

function refusal(status: number, error: string, code: string): Response {
  return new Response(JSON.stringify({ error, code }), { status, headers: { 'Content-Type': 'application/json' } });
}

/** `value` as a URL's origin (`https://app.example`: lowercased, no default port, no path), or `undefined` for `null` or anything that is not an http(s) URL. */
function originOf(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** What the guards read of a request's headers (header names lowercased). */
type HeaderSource = { get(name: string): string | null };

/**
 * The hosts a request was sent to: its `Host` header, else `fallbackHost`
 * (the URL's). `X-Forwarded-Host` and `Forwarded` are *not* read: a client
 * can send them, so they would let a cross-site `Origin` name itself as the
 * request's own host. A proxy that rewrites `Host` is covered by listing the
 * public origin in `allowedOrigins`.
 */
function requestHosts(headers: HeaderSource, fallbackHost: string | undefined): string[] {
  const host = headers.get('host') ?? fallbackHost;
  return host === undefined ? [] : [host];
}

/** Whether `host` (a `Host`-style `name[:port]`) names the same host as `origin`, the port compared after the origin's scheme default is dropped (`agent.example:443` is `https://agent.example`). */
function sameHost(origin: URL, host: string): boolean {
  try {
    return new URL(`${origin.protocol}//${host}`).host === origin.host;
  } catch {
    return false;
  }
}

/** Whether `origin` is listed in `allowedOrigins`, each entry compared as an origin (case, a trailing slash and a default port do not matter). */
function originListed(origin: URL | undefined, raw: string, allowedOrigins: readonly string[] | undefined): boolean {
  return (allowedOrigins ?? []).some((allowed) => {
    const entry = originOf(allowed);
    return entry && origin ? entry.origin === origin.origin : allowed.toLowerCase() === raw.toLowerCase();
  });
}

/**
 * Whether a request comes from a web page on another site: an `Origin` that
 * is not the one the request was sent to (its `Host`; never a forwarded
 * header a client can set) and not in `allowedOrigins`, or `Sec-Fetch-Site:
 * cross-site` without such an `Origin`. A request without either header
 * (curl, a server, a webhook sender) is not a browser's cross-site request.
 * Also used by the channels (`headers` of a `node:http` request).
 */
export function crossSiteRequest(headers: HeaderSource, fallbackHost: string | undefined, allowedOrigins?: readonly string[]): boolean {
  if (allowedOrigins?.includes('*')) return false;
  const raw = headers.get('origin');
  if (raw !== null) {
    const origin = originOf(raw);
    if (originListed(origin, raw, allowedOrigins)) return false;
    return origin === undefined || !requestHosts(headers, fallbackHost).some((host) => sameHost(origin, host));
  }
  return headers.get('sec-fetch-site') === 'cross-site';
}

/**
 * Whether the `Content-Type` is JSON (`application/json`, or a `+json` type),
 * parameters aside. A header sent twice with the same JSON type (a client that
 * added `content-type` next to the default `Content-Type`) arrives joined with
 * `,`: every listed type must be JSON.
 */
export function isJsonContentType(header: string | null | undefined): boolean {
  const types = (header ?? '').split(',').map((part) => part.split(';')[0].trim().toLowerCase());
  return types.length > 0 && types.every((type) => type === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(type));
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
  if (crossSiteRequest(request.headers, new URL(request.url).host, options.allowedOrigins)) {
    return refusal(403, 'Cross-site request refused. Add the calling page\'s origin to allowedOrigins.', 'LOUSHO_REQUEST_FORBIDDEN');
  }
  if (options.requireJsonBody !== false && !isJsonContentType(request.headers.get('content-type'))) {
    return refusal(415, "Request body must be JSON: send 'Content-Type: application/json'.", 'LOUSHO_UNSUPPORTED_MEDIA_TYPE');
  }
  return undefined;
}

/** How many session owners the default session check keeps per agent before it forgets the least recently used one. */
export const MAX_SESSION_OWNERS = 100_000;

let ownerLimit = MAX_SESSION_OWNERS;

/** @internal Sets the owner cap ({@link MAX_SESSION_OWNERS} by default) and returns the previous one; for tests. */
export function setSessionOwnerLimit(limit: number): number {
  const previous = ownerLimit;
  ownerLimit = limit;
  return previous;
}

/** How many session records one principal may own per agent. a single caller could otherwise POST fresh session ids until every other owner's record was evicted past {@link MAX_SESSION_OWNERS}, locking each of them out of their stored sessions. */
export const MAX_OWNERS_PER_PRINCIPAL = 1024;

let perPrincipalLimit = MAX_OWNERS_PER_PRINCIPAL;

/** @internal Sets the per-principal owner cap ({@link MAX_OWNERS_PER_PRINCIPAL} by default) and returns the previous one; for tests. */
export function setSessionPrincipalLimit(limit: number): number {
  const previous = perPrincipalLimit;
  perPrincipalLimit = limit;
  return previous;
}

/** A principal as a map key: the fields {@link samePrincipal} compares. */
function principalKey(principal: Principal): string {
  return `${principal.type}\u0000${principal.authenticator}\u0000${principal.issuer ?? ''}\u0000${principal.id}`;
}

/** Per agent: each session id and the principal that started it, least recently used first. */
const owners = new WeakMap<object, Map<string, Principal>>();

/** Per agent: {@link principalKey} -> how many session ids that principal currently owns. */
const ownerCounts = new WeakMap<object, Map<string, number>>();

function countClaim(agent: object, principal: Principal, delta: 1 | -1): number {
  let counts = ownerCounts.get(agent);
  if (!counts) ownerCounts.set(agent, (counts = new Map()));
  const key = principalKey(principal);
  const next = (counts.get(key) ?? 0) + delta;
  if (next <= 0) counts.delete(key);
  else counts.set(key, next);
  return next;
}

/**
 * The principal recorded as the owner of session `sessionId` of `agent`, or
 * `undefined` when none is (never claimed, or forgotten: the record is kept in
 * memory per agent object for at most {@link MAX_SESSION_OWNERS} sessions).
 * Marks the session as recently used.
 */
export function sessionOwner(agent: object, sessionId: string): Principal | undefined {
  const sessions = owners.get(agent);
  const owner = sessions?.get(sessionId);
  if (sessions && owner !== undefined) {
    // A Map iterates in insertion order: re-inserting moves the id to the most recently used end.
    sessions.delete(sessionId);
    sessions.set(sessionId, owner);
  }
  return owner;
}

/**
 * Records `principal` as the owner of session `sessionId` of `agent` when it
 * has none, and answers whether `principal` holds the claim afterward: `true`
 * when it was just taken (or was `principal`'s already), `false` when another
 * principal owns it. The check-and-set is one synchronous step, so a
 * `false` answer means a concurrent first touch won the id and this caller
 * must be refused - never streamed a turn inside that principal's session.
 * `false` too when `principal` already owns {@link MAX_OWNERS_PER_PRINCIPAL}
 * sessions: one caller cannot evict every other owner by flooding new ids.
 */
export function claimSession(agent: object, sessionId: string, principal: Principal): boolean {
  let sessions = owners.get(agent);
  if (!sessions) owners.set(agent, (sessions = new Map()));
  const owner = sessions.get(sessionId);
  if (owner !== undefined) return samePrincipal(owner, principal);
  if ((ownerCounts.get(agent)?.get(principalKey(principal)) ?? 0) >= perPrincipalLimit) return false;
  sessions.set(sessionId, principal);
  countClaim(agent, principal, 1);
  for (const oldest of sessions.keys()) {
    if (sessions.size <= ownerLimit) break;
    const evicted = sessions.get(oldest);
    sessions.delete(oldest);
    if (evicted !== undefined) countClaim(agent, evicted, -1);
  }
  return true;
}

/** Forgets `principal`'s claim on session `sessionId` of `agent` (a turn that stored nothing); another principal's claim is kept. */
export function releaseSession(agent: object, sessionId: string, principal: Principal): void {
  const sessions = owners.get(agent);
  const owner = sessions?.get(sessionId);
  if (owner !== undefined && samePrincipal(owner, principal)) {
    sessions?.delete(sessionId);
    countClaim(agent, owner, -1);
  }
}
