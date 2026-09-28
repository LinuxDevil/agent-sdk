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

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
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

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  holder: AgentHolder
): Promise<void> {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    try {
      serveChatUi(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('dev UI not found');
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/chat') {
    try {
      const body = await readBody(req);
      const { message } = JSON.parse(body || '{}');
      if (typeof message !== 'string' || !message) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Request body must be JSON with a 'message' string" }));
        return;
      }

      const result = await holder.agent.send(message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
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

  const watcher = fs.watch(configPath, { persistent: false }, () => {
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

  const server = http.createServer((req, res) => {
    handleRequest(req, res, holder).catch((error) => {
      // eslint-disable-next-line no-console
      console.error('[loushy dev] unhandled request error:', error);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
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
