/**
 * Streamable HTTP front for `serveMcp`. Stateless: every request gets its own
 * `McpServer` + transport pair, which is what the MCP SDK recommends when no
 * session state is kept.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadOptionalPeer } from '../../../providers/optionalPeer';
import { checkWebhookAuth } from '../../../triggers/webhookAuth';

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
}

/** A running HTTP listener. */
interface HttpListener {
  port: number;
  host: string;
  path: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
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

async function serveRequest(
  createServer: () => Promise<McpServer>,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readJsonBody(req);
  const mcp = await createServer();
  const { StreamableHTTPServerTransport } = await loadOptionalPeer('@modelcontextprotocol/sdk', () =>
    import('@modelcontextprotocol/sdk/server/streamableHttp.js')
  );
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function handle(
  createServer: () => Promise<McpServer>,
  path: string,
  auth: McpHttpTransportOptions['auth'],
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (new URL(req.url ?? '/', 'http://localhost').pathname !== path) {
    return jsonRpcError(res, 404, `Not found. The MCP endpoint is ${path}.`);
  }
  if (auth && (await checkWebhookAuth(auth, req, Buffer.alloc(0)))) {
    return jsonRpcError(res, 401, 'Unauthorized: send "Authorization: Bearer <token>".', {
      'WWW-Authenticate': 'Bearer',
    });
  }
  if (req.method !== 'POST') {
    return jsonRpcError(res, 405, 'Method not allowed: this server is stateless, use POST.', { Allow: 'POST' });
  }
  try {
    await serveRequest(createServer, req, res);
  } catch (error) {
    if (!res.headersSent) jsonRpcError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

function assertAuth(auth: McpHttpTransportOptions['auth']): void {
  if (auth && !auth.token) {
    throw new Error(
      "serveMcp: transport.auth.token must be a non-empty string (e.g. auth: { type: 'bearer', token: process.env.MCP_TOKEN })."
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
  const server = http.createServer((req, res) => {
    void handle(createServer, path, options.auth, req, res);
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
