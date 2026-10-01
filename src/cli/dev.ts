/**
 * `loushy dev` - a local dev server for iterating on an agent (LOU-H6).
 *
 * Serves:
 *   GET  /health  -> 200 'ok'
 *   GET  /        -> the minimal chat UI (LOU-H7)
 *   /chat routes  -> sessions, SSE streaming and approvals (LOU-D32), shared with
 *                    the deployed node server: see src/server/chatRoutes.ts
 *
 * Config loading (LOU-H9): configPath is a declarative agent spec file
 * (.yaml/.yml or .json - see src/spec/schema.ts's AgentSpec), loaded and
 * zod-validated via loadSpec() and turned into a live agent via
 * specToAgent(). This retrofits LOU-H6's original ad-hoc
 * {name, prompt, provider, tools} JSON loader now that LOU-H9 (the
 * designed-for successor) exists - the two shapes are compatible (a plain
 * .json config in the old shape is a valid AgentSpec), so no existing
 * configs need to change.
 *
 * Targets (LOU-D31): the path may also be an agent directory (loadAgentDir)
 * or a .ts/.js module exporting a SimpleAgent / createAgent() config; see
 * devReload.ts for detection, watching and the reload swap.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleChatRequest, sendJson, sendText, type ChatRoutesContext } from '../server/chatRoutes';
import { detectTarget, hasOwnStore, startReloader, type DevOptions, type DevState } from './devReload';

export type { DevOptions } from './devReload';

export interface DevServerHandle {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
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
type AgentHolder = DevState;

type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse, holder: AgentHolder) => void;

function handleChatUi(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    serveChatUi(res);
  } catch {
    sendText(res, 404, 'dev UI not found');
  }
}

function handleStatus(_req: http.IncomingMessage, res: http.ServerResponse, holder: AgentHolder): void {
  const { target, reloads, error } = holder;
  sendJson(res, 200, { kind: target.kind, path: target.path, reloads, error: error ?? null });
}

const ROUTES = new Map<string, RouteHandler>([
  ['GET /health', (_req, res) => sendText(res, 200, 'ok')],
  ['GET /dev/status', handleStatus],
  ['GET /', handleChatUi],
]);

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, holder: AgentHolder): Promise<void> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const handler = ROUTES.get(`${req.method} ${pathname}`);
  if (handler) return handler(req, res, holder);
  const chat: ChatRoutesContext = {
    name: 'loushy dev',
    agent: () => holder.agent,
    // The dev store keeps sessions across reloads, unless the agent brought its own.
    session: (agent, id) => agent.session(hasOwnStore(agent) ? { id } : { id, store: holder.store }),
  };
  if (!(await handleChatRequest(req, res, chat))) sendText(res, 404, 'not found');
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
 * `configPath` is a spec file, an agent directory or a .ts/.js agent module
 * (detected by path type and extension, see `detectTarget`). Its sources are
 * watched (LOU-H8, LOU-D31): on a valid edit the live agent is swapped
 * in-place through the mutable AgentHolder above and the previous agent is
 * closed; on an invalid edit the error is logged and shown in the chat UI,
 * and the previous working agent is kept - the server never crashes and never
 * drops the port on a bad edit.
 */
export async function startDevServer(
  configPath: string,
  port = 3737,
  host = '127.0.0.1',
  options: DevOptions = {}
): Promise<DevServerHandle> {
  const reloader = await startReloader(detectTarget(configPath), options);
  const server = createDevHttpServer(reloader.state);
  try {
    await listenOnPort(server, port, host);
  } catch (error) {
    await reloader.close();
    throw error;
  }

  return {
    server,
    port,
    close: async () => {
      await reloader.close();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
