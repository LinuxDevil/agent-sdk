/**
 * `WS /agents/:id/stream` (N1/N2) - pushes `StreamMessage`s
 * (types.ts) to subscribers of one agent's run: a `status` message on every
 * RunManager status transition (immediately on connect, too, so a client
 * that connects mid-run sees the current state without waiting for the
 * next transition) plus best-effort `event` messages forwarding the run's
 * `AgentEvent`s for lightweight in-progress visibility.
 *
 * Attached to the same underlying `http.Server` the Express app listens on
 * (see index.ts) via a manual `upgrade` handler, since matching a path
 * with a `:id` param needs a tiny bit of parsing `ws` doesn't do for you.
 */
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import type { RunManager } from './runRegistry';
import { isValidAgentId } from './types';
import type { StreamMessage } from '../shared/wireTypes';
import { checkApiAccess, checkHostAndOrigin, type StudioAccessOptions } from './auth';

const STREAM_PATH_RE = /^\/agents\/([^/]+)\/stream$/;

function send(ws: WebSocket, message: StreamMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * Parses `/agents/:id/stream` out of an upgrade request URL, or returns
 * undefined when the path doesn't match or the id fails the same
 * path-traversal boundary as app.ts's `/agents/:id` middleware - this
 * handler parses `:id` itself (see the module doc comment) rather than
 * going through Express routing, so it needs its own check before the id is
 * used as a registry/status key alongside the HTTP routes.
 */
function streamAgentId(req: IncomingMessage): string | undefined {
  const url = new URL(req.url ?? '', 'http://localhost');
  const match = STREAM_PATH_RE.exec(url.pathname);
  if (!match) return undefined;
  const agentId = decodeURIComponent(match[1]);
  return isValidAgentId(agentId) ? agentId : undefined;
}

/** Eve DUI-F1: the same Host/Origin/token gate as the HTTP API (see auth.ts); omitted `access` skips only the token. */
function rejectUpgrade(req: IncomingMessage, socket: Socket, access: StudioAccessOptions | undefined): boolean {
  const decision = access ? checkApiAccess(req, access) : checkHostAndOrigin(req, { token: '' });
  if (decision.ok) return false;
  const reason = decision.status === 401 ? 'Unauthorized' : 'Forbidden';
  const CRLF = '\r\n';
  socket.end(`HTTP/1.1 ${decision.status} ${reason}${CRLF}Connection: close${CRLF}Content-Length: 0${CRLF}${CRLF}`);
  return true;
}

export function attachWebSocketServer(
  server: HttpServer,
  runManager: RunManager,
  access?: StudioAccessOptions
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  // agentId -> connected sockets, so status/event broadcasts only fan out
  // to clients watching that one agent's run.
  const subscribers = new Map<string, Set<WebSocket>>();

  function broadcast(agentId: string, message: StreamMessage): void {
    const sockets = subscribers.get(agentId);
    if (!sockets) return;
    for (const ws of sockets) send(ws, message);
  }

  runManager.on('status', (payload) => broadcast(payload.agentId, { type: 'status', payload }));

  // 'event' plus O1/O2/O3 'log'/'span'/'debug' and P1 'chat' (the chat
  // transcript, reconciled from the real ExecutionResult.messages - see
  // chatReconcile.ts): same fan-out pattern as 'status', over the same WS
  // connection - no second channel.
  for (const type of ['event', 'log', 'span', 'debug', 'chat'] as const) {
    runManager.on(type, (agentId: string, payload: unknown) =>
      broadcast(agentId, { type, payload } as StreamMessage)
    );
  }

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (rejectUpgrade(req, socket, access)) return;
    const agentId = streamAgentId(req);
    if (!agentId) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let sockets = subscribers.get(agentId);
      if (!sockets) {
        sockets = new Set();
        subscribers.set(agentId, sockets);
      }
      sockets.add(ws);

      // Send current status immediately so a client connecting mid-run (or
      // after a pause) doesn't have to wait for the next transition.
      send(ws, { type: 'status', payload: runManager.status(agentId) });
      // P1: same for the chat transcript, so opening the Chat tab shows
      // history immediately rather than waiting for the next message.
      send(ws, { type: 'chat', payload: runManager.chatState(agentId) });

      ws.on('close', () => {
        sockets!.delete(ws);
        if (sockets!.size === 0) subscribers.delete(agentId);
      });
    });
  });

  return wss;
}
