/**
 * `loushy dev` - a local dev server for iterating on an agent (LOU-H6).
 *
 * Serves:
 *   GET  /health  -> 200 'ok'
 *   GET  /        -> the minimal chat UI (LOU-H7)
 *   POST /chat    -> { sessionId, input } in, the turn streamed as SSE out (LOU-D32);
 *                    the deprecated { message } still returns the ExecutionResult
 *   GET  /chat/:sessionId                     -> the session's transcript
 *   POST /chat/:sessionId/approvals/:id       -> { approved, note } or { answer }, the continuation streamed
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
import type { AgentInput } from '../providers/content';
import type { AgentEvent } from '../execution/agentEvents';
import { assertSessionId } from '../session/sessionStore';
import type { AgentSession } from '../session/AgentSession';
import { continuationEvents, errorEvents } from './devEvents';
import { detectTarget, hasOwnStore, startReloader, type DevOptions, type DevState } from './devReload';

export type { DevOptions } from './devReload';

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
type AgentHolder = DevState;

type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  holder: AgentHolder,
  params: string[]
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

const DONE_FRAME = 'event: done\ndata: {}\n\n';
let warnedLegacy = false;

/** Streams `events` as SSE (`data: <AgentEvent JSON>`, then `event: done`); a failure becomes `error` + `run.done` events. */
async function sendSse(res: http.ServerResponse, events: (signal: AbortSignal) => AsyncIterable<AgentEvent>): Promise<void> {
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const write = (event: AgentEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  try {
    for await (const event of events(controller.signal)) write(event);
  } catch (error) {
    errorEvents(error).forEach(write);
  }
  res.end(DONE_FRAME);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return ((JSON.parse((await readBody(req)) || '{}') as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
}

/** Sends the error status for a failed handler: 413 over the size cap, 400 for bad JSON, else 500. */
function sendFailure(res: http.ServerResponse, error: unknown): void {
  const status = error instanceof PayloadTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 500;
  sendJson(res, status, { error: (error as Error).message });
}

/** The session `sessionId` of the live agent, kept in the dev store (or the agent's own); sends 400 and returns undefined for an invalid id. */
function openSession(res: http.ServerResponse, holder: AgentHolder, sessionId: string): AgentSession | undefined {
  try {
    assertSessionId(sessionId);
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message });
    return undefined;
  }
  return holder.agent.session(hasOwnStore(holder.agent) ? { id: sessionId } : { id: sessionId, store: holder.store });
}

async function runChat(req: http.IncomingMessage, res: http.ServerResponse, holder: AgentHolder): Promise<void> {
  const { sessionId, input, message } = await readJson(req);
  if (typeof sessionId === 'string' && (typeof input === 'string' ? input : Array.isArray(input))) {
    const session = openSession(res, holder, sessionId);
    if (session) await sendSse(res, (signal) => session.stream(input as AgentInput, { signal }));
    return;
  }
  if (typeof message === 'string' && message) {
    if (!warnedLegacy) console.warn('[loushy dev] POST /chat { message } is deprecated: send { sessionId, input } for a session and a streamed turn.');
    warnedLegacy = true;
    res.setHeader('Deprecation', 'true');
    sendJson(res, 200, await holder.agent.send(message));
    return;
  }
  sendJson(res, 400, { error: "Request body must be JSON with 'sessionId' and 'input' strings (or the deprecated 'message')" });
}

async function runApproval(req: http.IncomingMessage, res: http.ServerResponse, holder: AgentHolder, [sessionId, id]: string[]): Promise<void> {
  if (!openSession(res, holder, sessionId)) return;
  const { approved, note, answer } = await readJson(req);
  if (typeof answer !== 'string' && typeof approved !== 'boolean') {
    sendJson(res, 400, { error: "Request body must be JSON with 'approved' (and optional 'note') or 'answer'" });
    return;
  }
  const { agent } = holder;
  const request = (await agent.approvals.list()).find((pending) => pending.id === id);
  if (!request) {
    sendJson(res, 404, { error: `No pending approval '${id}' (it was decided already, or the agent was reloaded)` });
    return;
  }
  await sendSse(res, async function* (signal) {
    const result =
      typeof answer === 'string'
        ? await agent.approvals.answer({ id, answer }, { signal })
        : await agent.approvals.resolve({ id, approved: approved === true, note: typeof note === 'string' ? note : undefined }, { signal });
    const pausedAgain = (await agent.approvals.list()).find((pending) => pending.id === result.approvalId);
    yield* continuationEvents(result, request, pausedAgain);
  });
}

async function runTranscript(_req: http.IncomingMessage, res: http.ServerResponse, holder: AgentHolder, [sessionId]: string[]): Promise<void> {
  const session = openSession(res, holder, sessionId);
  if (session) sendJson(res, 200, { sessionId, messages: await session.load(), pending: await session.pending() });
}

/** Wraps a handler so a failure before streaming starts answers with a JSON error. */
function guarded(run: RouteHandler): RouteHandler {
  return async (req, res, holder, params) => {
    try {
      await run(req, res, holder, params);
    } catch (error) {
      sendFailure(res, error);
    }
  };
}

function handleStatus(_req: http.IncomingMessage, res: http.ServerResponse, holder: AgentHolder): void {
  const { target, reloads, error } = holder;
  sendJson(res, 200, { kind: target.kind, path: target.path, reloads, error: error ?? null });
}

const ROUTES = new Map<string, RouteHandler>([
  ['GET /health', (_req, res) => sendText(res, 200, 'ok')],
  ['GET /dev/status', handleStatus],
  ['GET /', handleChatUi],
  ['POST /chat', guarded(runChat)],
]);

/** Routes with path parameters, passed to the handler as `params` (already URL-decoded). */
const PARAM_ROUTES: Array<[method: string, pattern: RegExp, handler: RouteHandler]> = [
  ['GET', /^\/chat\/([^/]+)$/, guarded(runTranscript)],
  ['POST', /^\/chat\/([^/]+)\/approvals\/([^/]+)$/, guarded(runApproval)],
];

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  holder: AgentHolder
): Promise<void> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  let handler = ROUTES.get(`${req.method} ${pathname}`);
  let params: string[] = [];
  for (const [method, pattern, route] of PARAM_ROUTES) {
    const match = method === req.method ? pattern.exec(pathname) : null;
    if (match) [handler, params] = [route, match.slice(1).map(decodeURIComponent)];
  }
  if (!handler) {
    sendText(res, 404, 'not found');
    return;
  }
  await handler(req, res, holder, params);
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
