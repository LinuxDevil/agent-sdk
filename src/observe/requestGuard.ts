/**
 * The observe daemon's /api/* guard against browsers. The daemon answers
 * loopback without auth, so any web page the developer opens could otherwise
 * write to it: a `text/plain` "simple" POST needs no CORS preflight (one
 * creating a judge rule with `sample_rate: 1` spends the user's provider keys
 * and sends their traces to an LLM), and DNS rebinding points an attacker's
 * own domain at 127.0.0.1. So, before routing:
 *
 * - bound to loopback, a `Host` that is not a loopback name answers 403
 *   (rebinding always carries the attacker's hostname; a missing `Host` is a
 *   non-browser client and passes);
 * - a write (anything but GET/HEAD/OPTIONS) whose `Origin` is present and not
 *   a loopback http(s) origin - `null` and empty included - or whose
 *   `Sec-Fetch-Site` is `cross-site` answers 403 (non-browser clients send no
 *   `Origin`);
 * - a write that carries a body or a `Content-Type` must say
 *   `application/json`, else 415 (bodyless DELETEs and empty POSTs pass).
 *
 * Internal to the daemon; not exported from the package.
 */
import type { IncomingHttpHeaders } from 'node:http';
import { hostnameOf, isLoopbackHost } from '../server/hostCheck';

/** Why a request was refused: the status and the `{ error, code }` body the daemon answers with. */
export interface GuardRejection {
  status: 403 | 415;
  error: string;
  code: 'LOUSHO_REQUEST_INVALID';
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const reject = (status: GuardRejection['status'], error: string): GuardRejection => ({ status, error, code: 'LOUSHO_REQUEST_INVALID' });

/** Whether a hostname (lowercase; IPv6 may keep its brackets; a trailing dot is ignored) names this machine. */
function isLoopbackName(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  return isLoopbackHost(name) || name.endsWith('.localhost');
}

/** Whether an `Origin` value is an http(s) origin on a loopback name; `null`, empty and anything unparseable are not. */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackName(url.hostname);
  } catch {
    return false;
  }
}

function hostRejection(headers: IncomingHttpHeaders, boundHost: string): GuardRejection | undefined {
  if (headers.host === undefined || !isLoopbackHost(boundHost)) return undefined;
  const hostname = hostnameOf(headers.host);
  if (hostname !== undefined && isLoopbackName(hostname)) return undefined;
  return reject(403, 'This observe daemon only answers loopback Host names (localhost, 127.0.0.1, [::1]); the request named another host.');
}

function originRejection(headers: IncomingHttpHeaders): GuardRejection | undefined {
  const crossOrigin = (headers.origin !== undefined && !isLoopbackOrigin(headers.origin)) || headers['sec-fetch-site'] === 'cross-site';
  return crossOrigin ? reject(403, 'Cross-origin writes to the observe daemon are refused; only loopback pages and non-browser clients may write.') : undefined;
}

function hasBody(headers: IncomingHttpHeaders): boolean {
  return Number(headers['content-length'] ?? 0) > 0 || headers['transfer-encoding'] !== undefined;
}

function contentTypeRejection(headers: IncomingHttpHeaders): GuardRejection | undefined {
  const type = headers['content-type'];
  if (type === undefined && !hasBody(headers)) return undefined;
  const media = (type ?? '').split(';')[0].trim().toLowerCase();
  return media === 'application/json' ? undefined : reject(415, 'Observe daemon write bodies must be sent as Content-Type: application/json.');
}

/** The refusal for one /api/* request (see the module doc), or `undefined` when it may be routed. `boundHost` is the daemon's listen address. */
export function guardApiRequest(method: string, headers: IncomingHttpHeaders, boundHost: string): GuardRejection | undefined {
  const hostRefused = hostRejection(headers, boundHost);
  if (hostRefused || SAFE_METHODS.has(method.toUpperCase())) return hostRefused;
  return originRejection(headers) ?? contentTypeRejection(headers);
}
