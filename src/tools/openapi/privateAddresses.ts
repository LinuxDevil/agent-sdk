/**
 * `openApiTools({ privateAddresses: 'refuse' })` (#291): the private-address
 * policy of `http_request` and `web_fetch` (N13a) for the operation requests
 * and the document fetch.
 *
 * - IP literals and the `localhost` names (RFC 6761: always loopback) are
 *   checked on the URL, when the tools are made and on every hop: a socket
 *   never resolves a literal, so nothing else would see it.
 * - Host names are checked at connection time by the shared pinned lookup
 *   (src/security/privateAddress.ts) on an undici `Agent`: the one resolution
 *   of the name is the one checked and the one the socket connects to, every
 *   address it returns is checked, and each redirect hop is a new connection
 *   through the same lookup. A DNS-rebinding name has no second lookup to
 *   answer.
 *
 * Node only (undici, node:dns). undici is loaded when tools with 'refuse' are
 * made, never at import time (LOU-D19); where it cannot load, making them
 * fails with a ConfigurationError instead of sending unchecked requests.
 */

import { isIP } from 'node:net';
import { ConfigurationError } from '../../execution/errors';
import { isHostPattern, matchesHost } from '../../security/hostPattern';
import { isPrivateAddress, pinnedLookup, SsrfBlockedError } from '../../security/privateAddress';
import { loadOptionalPeer } from '../../providers/optionalPeer';

/** What `privateAddresses` / `allowPrivate` resolved to. `refuse: false` checks nothing. */
export interface PrivateAddressPolicy {
  refuse: boolean;
  /** Lower-cased host patterns, IP literals without brackets. */
  allowPrivate: string[];
}

/** `[::1]` -> `::1`, lower-cased, without a trailing dot. */
function bareHost(host: string): string {
  return host.replace(/^\[(.*)\]$/, '$1').toLowerCase().replace(/\.$/, '');
}

/** Validates `privateAddresses`, `allowPrivate` and their combination with `fetch`. */
export function privateAddressPolicy(options: { privateAddresses?: unknown; allowPrivate?: readonly string[]; fetch?: unknown }): PrivateAddressPolicy {
  const mode = options.privateAddresses ?? 'allow';
  if (mode !== 'allow' && mode !== 'refuse') {
    throw new ConfigurationError(`openApiTools: 'privateAddresses' must be 'allow' or 'refuse'; got ${JSON.stringify(mode)}`, 'privateAddresses');
  }
  const refuse = mode === 'refuse';
  if (options.allowPrivate !== undefined && !refuse) {
    throw new ConfigurationError("openApiTools: 'allowPrivate' only applies with privateAddresses: 'refuse'", 'allowPrivate');
  }
  const allowPrivate = (options.allowPrivate ?? []).map((pattern) => (typeof pattern === 'string' ? bareHost(pattern) : pattern));
  const invalid = allowPrivate.filter((pattern) => typeof pattern !== 'string' || (!isHostPattern(pattern) && isIP(pattern) === 0));
  if (invalid.length > 0) {
    throw new ConfigurationError(
      `openApiTools: 'allowPrivate' entries must be host names, '*.' wildcards or IP addresses; got ${invalid.map((p) => JSON.stringify(p)).join(', ')}`,
      'allowPrivate'
    );
  }
  if (refuse && options.fetch !== undefined) {
    throw new ConfigurationError(
      "openApiTools: privateAddresses: 'refuse' cannot be combined with 'fetch': a custom fetch resolves host names itself, so the check could not pin the address it connects to. Drop 'fetch', or check destinations in your own fetch (or proxy).",
      'fetch'
    );
  }
  return { refuse, allowPrivate };
}

/**
 * Throws {@link SsrfBlockedError} when `hostname` is a private IP literal
 * (any form `new URL()` normalizes: decimal, octal, hex, IPv4-mapped IPv6) or
 * a `localhost` name, unless `allowPrivate` lists it. Other names are left to
 * the pinned lookup at connection time.
 */
export function assertHostAllowed(hostname: string, policy: PrivateAddressPolicy): void {
  if (!policy.refuse) return;
  const bare = bareHost(hostname);
  if (matchesHost(policy.allowPrivate, bare)) return;
  const refused = isIP(bare) !== 0 ? isPrivateAddress(bare) : bare === 'localhost' || bare.endsWith('.localhost');
  if (refused) throw new SsrfBlockedError(bare);
}

/**
 * A `fetch` that connects through an undici `Agent` whose `connect.lookup` is
 * the pinned lookup. Loads undici now, so a runtime without it fails here.
 */
export async function createPinnedFetch(policy: PrivateAddressPolicy): Promise<typeof fetch> {
  let undici: typeof import('undici');
  try {
    undici = await loadOptionalPeer('undici', () => import('undici'));
  } catch (error) {
    throw new ConfigurationError(
      "openApiTools: privateAddresses: 'refuse' needs Node.js (node:dns) and the undici package, to pin each connection to the address it checked. It is not available on this runtime.",
      'privateAddresses',
      'LOUSHO_CONFIG_INVALID',
      { cause: error }
    );
  }
  // The Agent lives as long as the tools (connections are pooled, as the global fetch pools them).
  const dispatcher = new undici.Agent({ connect: { lookup: pinnedLookup({ allowPrivate: policy.allowPrivate }) } });
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    let headers = init.headers;
    if (headers instanceof Headers) {
      const plain: Record<string, string> = {};
      headers.forEach((value, name) => (plain[name] = value));
      headers = plain;
    }
    return undici.fetch(String(input), { ...(init as object), headers, dispatcher } as Parameters<typeof undici.fetch>[1]);
  }) as unknown as typeof fetch;
}
