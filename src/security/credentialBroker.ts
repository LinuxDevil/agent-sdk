/**
 * Credential broker (LOU-X12): a host-side HTTP forward proxy that adds auth
 * headers for allowed hosts, so a sandboxed command can call an authenticated
 * API without the token ever entering its environment.
 *
 * Node-only (node:http, node:net), like the sandbox classes: exported from the
 * root entry through `src/security/index.ts`, which the Worker bundle never
 * imports.
 *
 * Header injection works on plain-HTTP requests (absolute-URI form) and on the
 * `/__broker/<host>/<path>` path form, which the broker forwards to
 * `https://<host>/<path>`. HTTPS through `CONNECT` is tunnelled untouched: the
 * allowlist is enforced on the tunnel target, but headers cannot be seen or
 * added (no TLS interception).
 *
 * `listen()` (LOU-X12.2) adds a listener on another address, e.g. the gateway
 * of an internal Docker network, that serves only peers from one subnet.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { lookup } from 'node:dns/promises';
import type { Duplex } from 'node:stream';
import { isHostPattern, matchesHost } from './hostPattern';

/** A header value to inject: a string, or a function called per request (e.g. to read a rotating token). */
export type BrokerHeaderValue = string | (() => string | Promise<string>);

export interface CredentialBrokerOptions {
  /**
   * Headers to inject per host (exact name or `*.suffix`), e.g.
   * `{ 'api.github.com': { authorization: () => 'Bearer ' + token } }`.
   * Rule hosts are allowed implicitly. Injection applies to plain-HTTP
   * requests and the `/__broker/` path form only, never to `CONNECT` tunnels.
   */
  rules: Readonly<Record<string, Readonly<Record<string, BrokerHeaderValue>>>>;
  /** Extra hosts the proxy may reach without injected headers. Anything else gets a 403. */
  allow?: readonly string[];
  /** Hosts that may resolve to loopback, link-local or private addresses (refused otherwise). */
  allowPrivate?: readonly string[];
  /** Port to listen on. Defaults to an ephemeral port. */
  port?: number;
  /** Address to bind. Defaults to `127.0.0.1` (loopback only). */
  host?: string;
  /** Upstream scheme for the `/__broker/<host>/<path>` form. Defaults to `'https'`; `'http'` is for plain-HTTP upstreams and tests. */
  pathFormScheme?: 'https' | 'http';
}

/** An extra listener (LOU-X12.2), e.g. on an internal Docker network's gateway address. */
export interface BrokerListenOptions {
  /** Address to bind, e.g. `172.18.0.1`. */
  host: string;
  /** Port to listen on. Defaults to an ephemeral port. */
  port?: number;
  /** Subnet whose peers may connect, e.g. `172.18.0.0/16`. Any other peer is disconnected before a byte is read. */
  clients: string;
  /** Hosts this listener's peers may reach besides the rule hosts. Defaults to the broker's `allow`. */
  allow?: readonly string[];
  /** @internal Test hook: reads a connection's peer address. Defaults to `socket.remoteAddress`. */
  peerAddress?: (socket: net.Socket) => string | undefined;
}

/** A listener started by {@link CredentialBroker.listen}. */
export interface BrokerListener {
  /** The proxy URL on the listener's address, e.g. `http://172.18.0.1:53211`. */
  readonly url: string;
  /** Proxy variables pointing at this listener, like {@link CredentialBroker.env}. Holds no secret. */
  readonly env: Readonly<Record<string, string>>;
  /** Stops this listener and destroys its sockets; the broker keeps running. */
  close(): Promise<void>;
}

export interface CredentialBroker {
  /** The proxy URL, e.g. `http://127.0.0.1:53211`. */
  readonly url: string;
  /** `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (and lower-case forms) for a command's `env`. Holds no secret. */
  readonly env: Readonly<Record<string, string>>;
  /** A base URL that reaches `https://<host>` with the injected headers: `<url>/__broker/<host>`. */
  baseUrl(host: string): string;
  /** Also listens on `host`, for peers in `clients` only (LOU-X12.2). `SubprocessSandbox` calls it for its Docker network. */
  listen(options: BrokerListenOptions): Promise<BrokerListener>;
  /** Stops every listener and destroys every open client and upstream socket. */
  close(): Promise<void>;
}

interface Policy {
  rules: Array<readonly [string, Readonly<Record<string, BrokerHeaderValue>>]>;
  allow: string[];
  allowPrivate: string[];
  scheme: 'https' | 'http';
}

/** A refusal whose message is safe to send to the sandbox (host names only, never header values). */
class Refused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

const PRIVATE = new net.BlockList();
for (const [prefix, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]] as const) {
  PRIVATE.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) PRIVATE.addSubnet(prefix, bits, 'ipv6');

/** True if `address` (IPv4, IPv6 or IPv4-mapped IPv6) is in `list`. */
function inList(list: net.BlockList, address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return list.check(mapped[1], 'ipv4');
  return list.check(address, net.isIPv6(address) ? 'ipv6' : 'ipv4');
}

/** Parses a `prefix/bits` subnet such as `172.18.0.0/16`. */
function subnet(cidr: string): net.BlockList {
  const [prefix, bits, extra] = cidr.split('/');
  const family = net.isIP(prefix);
  if (family === 0 || extra !== undefined || !/^\d+$/.test(bits ?? '') || Number(bits) > (family === 6 ? 128 : 32)) {
    throw new Error(`createCredentialBroker: listen() clients must be a subnet such as '172.18.0.0/16'; got ${JSON.stringify(cidr)}.`);
  }
  const list = new net.BlockList();
  list.addSubnet(prefix, Number(bits), family === 6 ? 'ipv6' : 'ipv4');
  return list;
}

function buildPolicy(options: CredentialBrokerOptions): Policy {
  const lower = (host: string) => host.toLowerCase();
  const rules = Object.entries(options.rules).map(([host, headers]) => [lower(host), headers] as const);
  const allow = [...rules.map(([host]) => host), ...(options.allow ?? []).map(lower)];
  const allowPrivate = (options.allowPrivate ?? []).map(lower);
  const invalid = [...allow, ...allowPrivate].filter((host) => !isHostPattern(host));
  if (invalid.length > 0) {
    throw new Error(`createCredentialBroker: hosts must be names such as 'api.github.com' or '*.npmjs.org'; got ${JSON.stringify(invalid)}.`);
  }
  return { rules, allow, allowPrivate, scheme: options.pathFormScheme ?? 'https' };
}

/** Checks the allowlist (before any DNS or connection), then resolves and refuses private addresses. Returns the address to dial. */
async function admit(policy: Policy, hostname: string): Promise<string> {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (!matchesHost(policy.allow, host)) throw new Refused(403, `${host} is not on the broker's allowlist`);
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Refused(502, `cannot resolve ${host}`);
  }
  if (!matchesHost(policy.allowPrivate, host) && addresses.some((a) => inList(PRIVATE, a.address))) {
    throw new Refused(403, `${host} resolves to a loopback, link-local or private address`);
  }
  return addresses[0].address;
}

/** The upstream URL of a proxied request: absolute `http://` form, or `/__broker/<host>/<path>`. */
function parseTarget(raw: string, scheme: Policy['scheme']): URL {
  const pathForm = /^\/__broker\/([a-z0-9.-]+(?::\d+)?)(\/.*)?$/i.exec(raw);
  try {
    if (pathForm) return new URL(`${scheme}://${pathForm[1]}${pathForm[2] ?? '/'}`);
    if (/^http:\/\//i.test(raw)) return new URL(raw);
  } catch {
    // fall through to the 400 below
  }
  throw new Refused(400, 'expected an absolute http:// URL or /__broker/<host>/<path>');
}

function stripHopByHop(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const listed = String(headers.connection ?? '').split(',').map((name) => name.trim().toLowerCase());
  const kept: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.includes(name) && !listed.includes(name)) kept[name] = value;
  }
  return kept;
}

/** Client headers minus hop-by-hop ones; for a brokered host, any client `Authorization` is dropped and the rule's headers win. */
async function upstreamHeaders(policy: Policy, req: http.IncomingMessage, url: URL): Promise<http.OutgoingHttpHeaders> {
  const headers = stripHopByHop(req.headers);
  headers.host = url.host;
  for (const [, inject] of policy.rules.filter(([pattern]) => matchesHost([pattern], url.hostname))) {
    delete headers.authorization;
    for (const [name, value] of Object.entries(inject)) {
      try {
        headers[name.toLowerCase()] = typeof value === 'function' ? await value() : value;
      } catch {
        throw new Refused(502, `the credential for ${url.hostname} could not be produced`);
      }
    }
  }
  return headers;
}

function refuse(res: http.ServerResponse, error: unknown): void {
  const { status, message } = error instanceof Refused ? error : { status: 502, message: 'request failed' };
  if (res.headersSent) res.destroy();
  else res.writeHead(status, { 'content-type': 'text/plain' }).end(`credential broker: ${message}\n`);
}

type Track = (socket: Duplex) => void;

function forward(req: http.IncomingMessage, res: http.ServerResponse, url: URL, address: string, headers: http.OutgoingHttpHeaders, track: Track): void {
  const secure = url.protocol === 'https:';
  const upstream = (secure ? https : http).request({
    host: address,
    port: Number(url.port) || (secure ? 443 : 80),
    servername: secure && !net.isIP(url.hostname) ? url.hostname : undefined,
    method: req.method,
    path: url.pathname + url.search,
    headers,
    agent: false,
  });
  upstream.on('socket', track);
  upstream.on('response', (response) => {
    res.writeHead(response.statusCode ?? 502, stripHopByHop(response.headers));
    response.pipe(res);
  });
  upstream.on('error', () => refuse(res, new Refused(502, `upstream ${url.host} failed`)));
  req.pipe(upstream);
}

async function handleRequest(policy: Policy, track: Track, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const url = parseTarget(req.url ?? '', policy.scheme);
    const address = await admit(policy, url.hostname);
    forward(req, res, url, address, await upstreamHeaders(policy, req, url), track);
  } catch (error) {
    refuse(res, error);
  }
}

const statusLine = (status: number) => `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n\r\n`;

/** HTTPS tunnels: the allowlist and private-address checks apply to the target; bytes pass untouched. */
async function handleConnect(policy: Policy, track: Track, req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  try {
    const { hostname, port } = new URL(`http://${req.url ?? ''}`);
    const address = await admit(policy, hostname);
    const upstream = net.connect(Number(port) || 443, address);
    track(upstream);
    let connected = false;
    upstream.once('connect', () => {
      connected = true;
      socket.write(statusLine(200));
      upstream.write(head);
      upstream.pipe(socket).on('error', () => upstream.destroy());
      socket.pipe(upstream);
    });
    upstream.on('error', () => (connected ? socket.destroy() : socket.end(statusLine(502))));
    socket.on('error', () => upstream.destroy());
  } catch (error) {
    socket.end(statusLine(error instanceof Refused ? error.status : 400));
  }
}

/** Proxy variables for a command's `env`; the broker's own address bypasses the proxy so `baseUrl()` works. */
function proxyEnv(url: string, host: string): Readonly<Record<string, string>> {
  return Object.freeze({ HTTP_PROXY: url, HTTPS_PROXY: url, NO_PROXY: host, http_proxy: url, https_proxy: url, no_proxy: host });
}

/**
 * Starts a credential broker. Pass `broker.env` to a command's `env` (for
 * example `new NodeWorkspace({ root, env: broker.env })`) so it uses the proxy.
 */
export async function createCredentialBroker(options: CredentialBrokerOptions): Promise<CredentialBroker> {
  const host = options.host ?? '127.0.0.1';
  const main = await serve(buildPolicy(options), { host, port: options.port });
  const extra = new Set<Listening>();
  return {
    url: main.url,
    env: proxyEnv(main.url, host),
    baseUrl: (target) => `${main.url}/__broker/${target}`,
    async listen({ allow, clients, ...where }) {
      const policy = buildPolicy({ ...options, allow: allow ?? options.allow });
      const listening = await serve(policy, { ...where, clients: subnet(clients) });
      extra.add(listening);
      const close = () => {
        extra.delete(listening);
        return listening.close();
      };
      return { url: listening.url, env: proxyEnv(listening.url, where.host), close };
    },
    close: async () => {
      await Promise.all([main, ...extra].map((listening) => listening.close()));
      extra.clear();
    },
  };
}

/** True when there is no subnet restriction, or `peer` is an address inside it. */
function admits(clients: net.BlockList | undefined, peer: string | undefined): boolean {
  if (!clients) return true;
  return peer !== undefined && net.isIP(peer) !== 0 && inList(clients, peer);
}

type Listening = { url: string; close: () => Promise<void> };
type ServeOptions = Pick<BrokerListenOptions, 'host' | 'port' | 'peerAddress'> & { clients?: net.BlockList };

/** Starts one listener for `policy`. With `clients`, a peer outside that subnet is disconnected at once. */
async function serve(policy: Policy, { host, port, clients, peerAddress = (s) => s.remoteAddress }: ServeOptions): Promise<Listening> {
  const sockets = new Set<Duplex>();
  const track: Track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  const server = http.createServer((req, res) => void handleRequest(policy, track, req, res));
  server.on('connection', (socket: net.Socket) => (admits(clients, peerAddress(socket)) ? track(socket) : socket.destroy()));
  server.on('connect', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void handleConnect(policy, track, req, socket, head));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port ?? 0, host, () => resolve());
  });
  return {
    url: `http://${net.isIPv6(host) ? `[${host}]` : host}:${(server.address() as net.AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
