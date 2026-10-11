/**
 * Loopback and `Host` header checks shared by the HTTP listeners that run on a
 * developer's machine (`lousho dev`, `serveMcp`'s HTTP transport,
 * `WebhookTriggerAdapter`) and by the session routes' `allowedHosts`. Exact
 * matches only: `127.attacker.example` is a domain name, not a loopback
 * address. No `node:*` import, so Worker code can use it.
 */

const LOOPBACK_NAMES = new Set(['localhost', '::1', '[::1]']);
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The four octets of a dotted-quad IPv4 address, or `undefined` for anything else. */
function ipv4Octets(host: string): number[] | undefined {
  const match = IPV4.exec(host);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

/** Whether `host` (a bind address, or a host name without its port) is loopback: `localhost`, `127.0.0.0/8` or `::1`. */
export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase();
  return LOOPBACK_NAMES.has(name) || ipv4Octets(name)?.[0] === 127;
}

/** Whether `host` is an IP address rather than a name. DNS rebinding needs a name it controls, so an IP literal in `Host` cannot be one. */
function isIpLiteral(host: string): boolean {
  return ipv4Octets(host) !== undefined || host.includes(':');
}

/** `0.0.0.0` / `::`: a bind to every interface. */
function isWildcardHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

/**
 * The lowercased host name of a `Host` header value, without the port (IPv6
 * keeps its brackets); `undefined` when it is empty or carries anything but a
 * host and port (`a@b`, `a/b`).
 */
export function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  try {
    const url = new URL(`http://${hostHeader}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined;
    return url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Whether a request's `Host` header may reach a server bound to `boundHost`
 * (DNS rebinding: a web page that re-points its own domain at your machine
 * still sends its own domain as `Host`). `allowedHosts`, when given, is the
 * whole list: the names (or `name:port`) it holds, `'*'` for any. Without it,
 * loopback names are accepted, and a bind that is not loopback also accepts IP
 * addresses and the bound host itself.
 */
export function hostHeaderAllowed(hostHeader: string | undefined, boundHost: string, allowedHosts?: readonly string[]): boolean {
  const allowed = allowedHosts?.map((entry) => entry.toLowerCase());
  if (allowed?.includes('*')) return true;
  const hostname = hostnameOf(hostHeader);
  if (hostname === undefined) return false;
  if (allowed) return allowed.includes(hostname) || allowed.includes((hostHeader ?? '').toLowerCase());
  if (isLoopbackHost(hostname)) return true;
  if (isLoopbackHost(boundHost)) return false;
  return isIpLiteral(hostname) || (!isWildcardHost(boundHost) && hostname === hostnameOf(boundHost.includes(':') && !boundHost.startsWith('[') ? `[${boundHost}]` : boundHost));
}
