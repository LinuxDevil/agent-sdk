/**
 * `loushy dev` - a local dev server for iterating on an agent (LOU-H6).
 *
 * Serves:
 *   GET  /health  -> 200 'ok'
 *   GET  /        -> the minimal chat UI (LOU-H7)
 *   POST /chat    -> { message } in, the agent's real ExecutionResult out
 *
 * Config loading (LOU-H9): configPath is a declarative agent spec file
 * (.yaml/.yml or .json - see src/spec/schema.ts's AgentSpec), loaded and
 * zod-validated via loadSpec() and turned into a live agent via
 * specToAgent(). This retrofits LOU-H6's original ad-hoc
 * {name, prompt, provider, tools} JSON loader now that LOU-H9 (the
 * designed-for successor) exists - the two shapes are compatible (a plain
 * .json config in the old shape is a valid AgentSpec), so no existing
 * configs need to change.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SimpleAgent } from '../createAgent';
import { loadSpec } from '../spec/loadSpec';
import { specToAgent } from '../spec/specToAgent';

function loadAgentFromConfig(configPath: string): SimpleAgent {
  return specToAgent(loadSpec(configPath));
}

export interface DevServerHandle {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

/** Body-size cap for POST /chat, matching common Node.js body-size-limit conventions. */
const MAX_BODY_BYTES = 1024 * 1024; // 1MB

class PayloadTooLargeError extends Error {}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        // Stop growing `body` once over the cap, but keep draining the
        // stream (rather than destroying it or dropping listeners) so the
        // client can finish writing and the connection doesn't deadlock -
        // we reject once the request actually ends.
        tooLarge = true;
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new PayloadTooLargeError(`Request body exceeds ${MAX_BODY_BYTES} byte limit`));
        return;
      }
      resolve(body);
    });
    req.on('error', reject);
  });
}

function serveChatUi(res: http.ServerResponse): void {
  const uiPath = path.join(__dirname, 'dev-ui', 'index.html');
  const html = fs.readFileSync(uiPath, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

/**
 * Mutable holder for the currently-loaded agent (LOU-H8), so /chat always
 * reads the latest reloaded version without restarting the HTTP server or
 * dropping connections.
 */
interface AgentHolder {
  agent: SimpleAgent;
}

type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  holder: AgentHolder
) => void | Promise<void>;

function sendText(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(text);
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function handleChatUi(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    serveChatUi(res);
  } catch {
    sendText(res, 404, 'dev UI not found');
  }
}

/** The `message` string of a POST /chat body, or undefined when missing/invalid. */
function parseChatMessage(body: string): string | undefined {
  const { message } = JSON.parse(body || '{}');
  return typeof message === 'string' && message ? message : undefined;
}

async function runChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  holder: AgentHolder
): Promise<void> {
  const message = parseChatMessage(await readBody(req));
  if (!message) {
    sendJson(res, 400, { error: "Request body must be JSON with a 'message' string" });
    return;
  }

  sendJson(res, 200, await holder.agent.send(message));
}

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  holder: AgentHolder
): Promise<void> {
  try {
    await runChat(req, res, holder);
  } catch (error) {
    const status = error instanceof PayloadTooLargeError ? 413 : 500;
    sendJson(res, status, { error: (error as Error).message });
  }
}

const ROUTES = new Map<string, RouteHandler>([
  ['GET /health', (_req, res) => sendText(res, 200, 'ok')],
  ['GET /', handleChatUi],
  ['POST /chat', handleChat],
]);

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  holder: AgentHolder
): Promise<void> {
  const handler = ROUTES.get(`${req.method} ${req.url}`);
  if (!handler) {
    sendText(res, 404, 'not found');
    return;
  }
  await handler(req, res, holder);
}

/** Reloads the agent into `holder` whenever configPath changes; keeps the old agent on a bad edit. */
function watchConfig(configPath: string, holder: AgentHolder): fs.FSWatcher {
  return fs.watch(configPath, { persistent: false }, () => {
    try {
      holder.agent = loadAgentFromConfig(configPath);
      // eslint-disable-next-line no-console
      console.log(`[loushy dev] reloaded config from ${configPath}`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        `[loushy dev] failed to reload ${configPath}, keeping previous config: ${
          (error as Error).message
        }`
      );
    }
  });
}

function createDevHttpServer(holder: AgentHolder): http.Server {
  return http.createServer((req, res) => {
    handleRequest(req, res, holder).catch((error) => {
      // eslint-disable-next-line no-console
      console.error('[loushy dev] unhandled request error:', error);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
  });
}

function listenOnPort(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`[loushy dev] port ${port} is already in use. Pass a different port.`));
      } else {
        reject(err);
      }
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Starts the dev server, binding to `host`:`port` (checked for availability
 * up front - EADDRINUSE is caught and rejected with a clear, port-naming
 * error rather than crashing uncaught).
 *
 * `host` defaults to '127.0.0.1' (localhost-only) since this is a local dev
 * tool and should not be reachable from the network by default. Pass an
 * explicit host (e.g. '0.0.0.0') to opt in to LAN access, such as testing
 * from a phone on the same network.
 *
 * Watches configPath (LOU-H8) via fs.watch: on a valid edit, the live
 * agent is swapped in-place through the mutable AgentHolder above; on an
 * invalid edit (e.g. a JSON syntax error, or a missing required field),
 * the error is logged and the previous working agent is kept - the server
 * never crashes and never drops the port on a bad config edit.
 */
export async function startDevServer(
  configPath: string,
  port = 3737,
  host = '127.0.0.1'
): Promise<DevServerHandle> {
  const holder: AgentHolder = { agent: loadAgentFromConfig(configPath) };

  const watcher = watchConfig(configPath, holder);
  const server = createDevHttpServer(holder);
  await listenOnPort(server, port, host);

  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        watcher.close();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
