/**
 * Eve DUI-F1: access control for the studio's API and WebSocket.
 *
 * The studio stores provider keys, starts runs and executes hook code, so a
 * request is only served when it:
 *   1. names a loopback host in its `Host` header (blocks DNS rebinding: a
 *      page on `evil.example` that re-resolves to 127.0.0.1 still sends
 *      `Host: evil.example`);
 *   2. carries no `Origin`, or the studio's own origin - the browser sets
 *      `Origin` on every cross-origin fetch and on every WebSocket upgrade,
 *      so another site (or another local port) can't drive the API;
 *   3. (API and WebSocket only, not the static client) presents the
 *      per-launch token `lousho studio` mints and prints in the studio URL,
 *      as the `x-lousho-studio-token` header or a `token` query parameter
 *      (the WebSocket can't set headers).
 *
 * There is no CORS middleware: the client is served by this same server
 * (or proxied same-origin by Vite in dev mode), so it never needs one.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const STUDIO_TOKEN_HEADER = 'x-lousho-studio-token';
export const STUDIO_TOKEN_ENV = 'LOUSHO_STUDIO_TOKEN';
/** Comma-separated extra origins to accept (dev mode: the Vite dev server's). */
export const STUDIO_ALLOWED_ORIGINS_ENV = 'LOUSHO_STUDIO_ALLOWED_ORIGINS';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** A fresh, unguessable per-launch token. */
export function mintStudioToken(): string {
  return randomBytes(24).toString('base64url');
}

export interface StudioAccessOptions {
  /** The per-launch token; required on API and WebSocket requests. */
  token: string;
  /**
   * Extra hostnames accepted in `Host` besides loopback - the `--host` the
   * server was bound to. `'*'` (a wildcard bind, `0.0.0.0` / `::`) accepts
   * any host; the token is then the only gate.
   */
  allowedHosts?: string[];
  /** Extra exact origins accepted besides the studio's own (`http://<Host>`). */
  allowedOrigins?: string[];
}

function hostnameOf(host: string): string {
  // `[::1]:4750` -> `[::1]`, `127.0.0.1:4750` -> `127.0.0.1`, `localhost` -> `localhost`.
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1).toLowerCase();
  return host.split(':')[0].toLowerCase();
}

function isAllowedHost(host: string | undefined, allowedHosts: string[]): boolean {
  if (!host) return false;
  const name = hostnameOf(host);
  return LOOPBACK_HOSTNAMES.has(name) || allowedHosts.includes('*') || allowedHosts.includes(name);
}

/** `Origin` must be absent, this server's own origin (`http://<Host>`), or one of `allowedOrigins`. */
function isAllowedOrigin(origin: string | undefined, host: string | undefined, allowedOrigins: string[]): boolean {
  if (origin === undefined) return true;
  const o = origin.toLowerCase();
  if (allowedOrigins.some((allowed) => allowed.toLowerCase() === o)) return true;
  if (!host) return false;
  const h = host.toLowerCase();
  return o === `http://${h}` || o === `https://${h}`;
}

function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function presentedToken(req: IncomingMessage): string | undefined {
  const fromHeader = header(req, STUDIO_TOKEN_HEADER);
  if (fromHeader) return fromHeader;
  return new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? undefined;
}

export type AccessDecision = { ok: true } | { ok: false; status: 401 | 403; error: string };

/** Host + Origin check, applied to every request (static client included). */
export function checkHostAndOrigin(req: IncomingMessage, options: StudioAccessOptions): AccessDecision {
  const host = header(req, 'host');
  if (!isAllowedHost(host, options.allowedHosts ?? [])) {
    return { ok: false, status: 403, error: 'Forbidden host' };
  }
  if (!isAllowedOrigin(header(req, 'origin'), host, options.allowedOrigins ?? [])) {
    return { ok: false, status: 403, error: 'Forbidden origin' };
  }
  return { ok: true };
}

/** Host + Origin + token, for the API routes and the WebSocket upgrade. */
export function checkApiAccess(req: IncomingMessage, options: StudioAccessOptions): AccessDecision {
  const base = checkHostAndOrigin(req, options);
  if (!base.ok) return base;
  if (!tokenMatches(presentedToken(req), options.token)) {
    return {
      ok: false,
      status: 401,
      error: 'Missing or invalid studio token - open the URL `lousho studio` printed (it ends in ?token=...)',
    };
  }
  return { ok: true };
}

/** Hostnames to accept besides loopback for a server bound to `host`. */
export function allowedHostsFor(host: string | undefined): string[] {
  if (host === '0.0.0.0' || host === '::') return ['*'];
  if (!host || LOOPBACK_HOSTNAMES.has(host)) return [];
  return [hostnameOf(host.includes(':') && !host.startsWith('[') ? `[${host}]` : host)];
}
