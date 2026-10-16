/**
 * Streamable HTTP front for `serveMcp`. Stateless: every request gets its own
 * `McpServer` + transport pair, which is what the MCP SDK recommends when no
 * session state is kept.
 */
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadOptionalPeer } from '../../../providers/optionalPeer';
import { checkWebhookAuth } from '../../../triggers/webhookAuth';
import { ConfigurationError } from '../../../execution/errors';
import { hostHeaderAllowed, isLoopbackHost } from '../../../server/hostCheck';

/** Options of the `{ type: 'http' }` transport. */
export interface McpHttpTransportOptions {
  type: 'http';
  /** Port to listen on. Use `0` for an ephemeral port. Defaults to `3920`. */
  port?: number;
  /** Interface to bind. Defaults to `'127.0.0.1'` (loopback only). */
  host?: string;
  /** URL path the MCP endpoint is served on. Defaults to `'/mcp'`. */
  path?: string;
  /**
   * Require `Authorization: Bearer <token>`. Strongly recommended whenever
   * `host` is not a loopback address.
   *
   * @example
   * ```ts
   * const transport = { type: 'http', host: '0.0.0.0', auth: { type: 'bearer', token: 'secret' } } as const;
   * ```
   */
  auth?: { type: 'bearer'; token: string };
  /**
   * Host names (or `host:port`) the `Host` header may carry; other requests
   * get `403`. This guards against DNS rebinding, where a web page re-points
   * its own domain at your machine. Defaults to loopback names (`localhost`,
   * `127.x.x.x` addresses, `[::1]`; never a name such as `127.example.com`) when `host` is loopback, and to no check otherwise.
   * `['*']` disables the check.
   *
   * @example
   * ```ts
   * const transport = { type: 'http', host: '0.0.0.0', allowedHosts: ['mcp.internal'], auth } as const;
   * ```
   */
  allowedHosts?: string[];
  /**
   * Extra origins (`'https://app.example'`) a browser request may come from.
   * A request with an `Origin` header that is neither same-origin with the
   * `Host` header nor listed gets `403`. Requests without `Origin` (non-browser
   * clients) are not affected. `['*']` disables the check.
   */
  allowedOrigins?: string[];
}

/** A running HTTP listener. */
interface HttpListener {
  port: number;
  host: string;
  path: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Whether the request's `Host` header is acceptable for a listener bound to `boundHost`: no check on a non-loopback bind without `allowedHosts`. */
function hostAllowed(hostHeader: string, boundHost: string, allowedHosts: string[] | undefined): boolean {
  return hostHeaderAllowed(hostHeader, boundHost, allowedHosts ?? (isLoopbackHost(boundHost) ? undefined : ['*']));
}

/** The lowercased `host` of an `Origin` header value, or `undefined` when it does not parse. */
function originHostOf(origin: string): string | undefined {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Why the request's `Host` / `Origin` is refused (DNS rebinding), else `undefined`. */
function rebindingRefusal(
  req: http.IncomingMessage,
  boundHost: string,
  options: Pick<McpHttpTransportOptions, 'allowedHosts' | 'allowedOrigins'>
): string | undefined {
  const hostHeader = (req.headers.host ?? '').toLowerCase();
  if (!hostAllowed(hostHeader, boundHost, options.allowedHosts)) {
    return `Forbidden: Host "${hostHeader}" is not allowed. Add it to transport.allowedHosts.`;
  }
  const origin = req.headers.origin;
  if (origin === undefined || options.allowedOrigins?.includes('*')) return undefined;
  if (options.allowedOrigins?.includes(origin)) return undefined;
  const originHost = originHostOf(origin);
  if (originHost !== undefined && originHost === hostHeader) return undefined;
  return `Forbidden: Origin "${origin}" is not allowed. Add it to transport.allowedOrigins.`;
}

function jsonRpcError(
  res: http.ServerResponse,
  status: number,
  message: string,
  headers: http.OutgoingHttpHeaders = {}
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      if (bytes > MAX_BODY_BYTES) return reject(new Error('Request body is too large.'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * The requests in flight on a listener, so a `notifications/cancelled` (which,
 * the transport being stateless, arrives in another POST and so at another
 * `McpServer`) can stop the run it names. A request is known by its JSON-RPC
 * id and the client that sent it: the `Mcp-Session-Id` the listener handed out
 * on `initialize` (which Streamable HTTP clients send back on every request),
 * or, for a client that sends none, its remote address, `Authorization` and
 * `User-Agent`. A cancel that matches several requests is ambiguous and is
 * ignored.
 */
type InFlight = Map<string, Set<() => void>>;

interface JsonRpcMessage {
  id?: unknown;
  method?: unknown;
  params?: { requestId?: unknown };
}

function messagesOf(body: unknown): JsonRpcMessage[] {
  const list = Array.isArray(body) ? body : [body];
  return list.filter((message): message is JsonRpcMessage => typeof message === 'object' && message !== null);
}

function requestKey(req: http.IncomingMessage, id: unknown): string {
  const session = req.headers['mcp-session-id'];
  if (typeof session === 'string' && session) return JSON.stringify(['session', req.headers.authorization ?? '', session, id]);
  return JSON.stringify([req.socket.remoteAddress ?? '', req.headers.authorization ?? '', req.headers['user-agent'] ?? '', id]);
}

/** The ids of the JSON-RPC requests (not notifications) in `body`. */
function requestIds(body: unknown): Array<string | number> {
  return messagesOf(body)
    .filter((message) => typeof message.method === 'string')
    .map((message) => message.id)
    .filter((id): id is string | number => typeof id === 'string' || typeof id === 'number');
}

/** Answers each request in a cancelled POST with a JSON-RPC error, so whoever waits on it is not left hanging. */
function answerCancelled(res: http.ServerResponse, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const errors = requestIds(body).map((id) => ({ jsonrpc: '2.0', id, error: { code: -32800, message: 'Request cancelled' } }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(Array.isArray(body) ? errors : errors[0]));
}

/** Whether `body` holds an `initialize` request. */
function isInitialize(body: unknown): boolean {
  return messagesOf(body).some((message) => message.method === 'initialize');
}

/** Stops the run of each request a `notifications/cancelled` in `body` names, when exactly one matches. */
function relayCancels(inFlight: InFlight, req: http.IncomingMessage, body: unknown): void {
  for (const message of messagesOf(body)) {
    if (message.method !== 'notifications/cancelled' || message.params?.requestId === undefined) continue;
    const cancels = inFlight.get(requestKey(req, message.params.requestId));
    if (cancels?.size === 1) for (const cancel of cancels) cancel();
  }
}

/** Registers `cancel` for the requests in `body`; returns the function that unregisters them. */
function track(inFlight: InFlight, req: http.IncomingMessage, body: unknown, cancel: () => void): () => void {
  const keys = requestIds(body).map((id) => requestKey(req, id));
  for (const key of keys) inFlight.set(key, (inFlight.get(key) ?? new Set()).add(cancel));
  return () => {
    for (const key of keys) {
      const cancels = inFlight.get(key);
      cancels?.delete(cancel);
      if (cancels?.size === 0) inFlight.delete(key);
    }
  };
}

async function serveRequest(
  createServer: () => Promise<McpServer>,
  inFlight: InFlight,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readJsonBody(req);
  relayCancels(inFlight, req, body);
  const mcp = await createServer();
  const { StreamableHTTPServerTransport } = await loadOptionalPeer('@modelcontextprotocol/sdk', () =>
    import('@modelcontextprotocol/sdk/server/streamableHttp.js')
  );
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  // The server keeps no session state, but a session id tells clients that share an address, token and
  // User-Agent apart, so a cancel only reaches the requests of the client that sent it.
  if (isInitialize(body)) res.setHeader('Mcp-Session-Id', randomUUID());
  // Closing the server aborts its in-flight handlers' signals, which cancels the agent run. That happens when the
  // client disconnects, and when a later POST cancels this request (`notifications/cancelled`).
  const close = () => {
    void transport.close();
    void mcp.close();
  };
  const untrack = track(inFlight, req, body, () => {
    close();
    // A closed transport never answers the request: answer it here.
    answerCancelled(res, body);
  });
  res.on('close', () => {
    untrack();
    close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function handle(
  createServer: () => Promise<McpServer>,
  inFlight: InFlight,
  path: string,
  options: McpHttpTransportOptions & { host: string },
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const { auth } = options;
  if (new URL(req.url ?? '/', 'http://localhost').pathname !== path) {
    return jsonRpcError(res, 404, `Not found. The MCP endpoint is ${path}.`);
  }
  const refusal = rebindingRefusal(req, options.host, options);
  if (refusal) return jsonRpcError(res, 403, refusal);
  if (auth && (await checkWebhookAuth(auth, req, Buffer.alloc(0)))) {
    return jsonRpcError(res, 401, 'Unauthorized: send "Authorization: Bearer <token>".', {
      'WWW-Authenticate': 'Bearer',
    });
  }
  if (req.method !== 'POST') {
    return jsonRpcError(res, 405, 'Method not allowed: this server is stateless, use POST.', { Allow: 'POST' });
  }
  try {
    await serveRequest(createServer, inFlight, req, res);
  } catch (error) {
    if (!res.headersSent) jsonRpcError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

function assertAuth(auth: McpHttpTransportOptions['auth']): void {
  if (auth && !auth.token) {
    throw new ConfigurationError(
      "serveMcp: transport.auth.token must be a non-empty string (e.g. auth: { type: 'bearer', token: process.env.MCP_TOKEN }).",
      'transport'
    );
  }
}

/** Starts the HTTP listener. Resolves once it is accepting connections. */
export function listenHttp(
  options: McpHttpTransportOptions,
  createServer: () => Promise<McpServer>,
  warn: (message: string) => void
): Promise<HttpListener> {
  const host = options.host ?? '127.0.0.1';
  const path = options.path ?? '/mcp';
  assertAuth(options.auth);
  if (!options.auth && !isLoopbackHost(host)) {
    warn(
      `serveMcp: listening on ${host} without authentication - anyone who can reach this port can run your agent. ` +
        "Set transport.auth ({ type: 'bearer', token }) or bind 127.0.0.1."
    );
  }
  const inFlight: InFlight = new Map();
  const server = http.createServer((req, res) => {
    void handle(createServer, inFlight, path, { ...options, host }, req, res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 3920, host, () => {
      const { port } = server.address() as AddressInfo;
      const close = () =>
        new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        });
      resolve({ port, host, path, close });
    });
  });
}
