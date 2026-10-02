/**
 * Private-address checks shared by the outbound-request code paths (N13a):
 * the credential broker, the `http_request` tool and the `web_fetch` tool.
 *
 * Node-only (node:net, node:dns). The Worker bundle never imports it.
 *
 * {@link pinnedLookup} is the piece that closes DNS rebinding: it is the one
 * and only resolution of a host name for a connection. It checks every
 * address the name resolves to and hands the socket exactly the address it
 * checked, so a name that answers a public address to a pre-check and a
 * private one to the connection has no second lookup to answer.
 */

import * as net from 'node:net';
import { promises as dnsPromises } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { matchesHost } from './hostPattern';

const PRIVATE = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  PRIVATE.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
  ['::', 127],
  ['64:ff9b::', 96],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(prefix, bits, 'ipv6');
}

/** `[::1]` -> `::1`, lower-cased. */
function bareHost(host: string): string {
  return host.replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (`::ffff:a.b.c.d` or `::ffff:HHHH:HHHH`), else null. */
function mappedIPv4(address: string): string | null {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

/**
 * True if `address` (IPv4, IPv6, bracketed IPv6 or IPv4-mapped IPv6) is a
 * loopback, private, link-local, shared, benchmark, multicast or reserved
 * address, or a NAT64 / 6to4 address (both can reach IPv4 private space).
 * Anything that is not an IP address counts as private (fail closed).
 */
export function isPrivateAddress(address: string): boolean {
  const bare = bareHost(address);
  const family = net.isIP(bare);
  if (family === 0) return true;
  if (family === 4) return PRIVATE.check(bare, 'ipv4');
  const v4 = mappedIPv4(bare);
  if (v4 !== null) return net.isIPv4(v4) ? PRIVATE.check(v4, 'ipv4') : true;
  return PRIVATE.check(bare, 'ipv6');
}

/**
 * Thrown (or passed to the lookup callback) when a host is, or resolves to, a
 * private address. The message names the host only, never the addresses.
 */
export class SsrfBlockedError extends Error {
  constructor(readonly host: string) {
    super(`${host} is or resolves to a loopback, link-local or private address`);
    this.name = 'SsrfBlockedError';
  }
}

/** True if `error` or anything on its `cause` chain is an {@link SsrfBlockedError}. */
export function findSsrfBlockedError(error: unknown): SsrfBlockedError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth++) {
    if (current instanceof SsrfBlockedError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Options of {@link pinnedLookup} and {@link resolvePublicAddresses}. */
export interface PinnedLookupOptions {
  /** Host patterns (`intranet.local`, `*.corp.example`) allowed to be or resolve to private addresses. */
  allowPrivate?: readonly string[];
}

/**
 * Resolves `host` once (an IP literal is not resolved) and returns every
 * address, after checking that none is private unless the host matches
 * `allowPrivate`. Throws {@link SsrfBlockedError} otherwise.
 */
export async function resolvePublicAddresses(host: string, options: PinnedLookupOptions = {}): Promise<LookupAddress[]> {
  const bare = bareHost(host);
  const allowPrivate = (options.allowPrivate ?? []).map((pattern) => pattern.toLowerCase());
  const exempt = matchesHost(allowPrivate, bare);
  const family = net.isIP(bare);
  if (family !== 0) {
    if (!exempt && isPrivateAddress(bare)) throw new SsrfBlockedError(bare);
    return [{ address: bare, family }];
  }
  const addresses = await dnsPromises.lookup(bare, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${bare}`), { code: 'ENOTFOUND', hostname: bare });
  }
  if (!exempt && addresses.some((entry) => isPrivateAddress(entry.address))) throw new SsrfBlockedError(bare);
  return addresses;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A `dns.lookup`-compatible function, as `net.connect({ lookup })` and undici's `connect.lookup` take it. */
export type PinnedLookupFunction = (hostname: string, options: LookupOptions | number | LookupCallback, callback?: LookupCallback) => void;

/**
 * A `dns.lookup`-compatible function for undici's `connect.lookup` (or
 * `net.connect({ lookup })`). It resolves the host through
 * {@link resolvePublicAddresses}, fails the connection with
 * {@link SsrfBlockedError} when any address is private, and otherwise gives
 * the socket the addresses it checked, so the connection goes to exactly
 * what was checked.
 */
export function pinnedLookup(options: PinnedLookupOptions = {}): PinnedLookupFunction {
  return (hostname, lookupOptions, maybeCallback) => {
    const callback = (typeof lookupOptions === 'function' ? lookupOptions : maybeCallback) as LookupCallback;
    const opts: LookupOptions =
      typeof lookupOptions === 'object' && lookupOptions !== null ? lookupOptions : typeof lookupOptions === 'number' ? { family: lookupOptions } : {};
    resolvePublicAddresses(hostname, options).then(
      (addresses) => {
        const wanted = opts.family === 4 || opts.family === 6 ? addresses.filter((entry) => entry.family === opts.family) : addresses;
        if (wanted.length === 0) {
          callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname }), '');
          return;
        }
        if (opts.all) callback(null, wanted);
        else callback(null, wanted[0].address, wanted[0].family);
      },
      (error: NodeJS.ErrnoException) => callback(error, '')
    );
  };
}
