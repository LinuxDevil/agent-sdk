/**
 * `WS /agents/:id/stream` (N1/N2) - pushes `StreamMessage`s
 * (types.ts) to subscribers of one agent's run: a `status` message on every
 * RunManager status transition (immediately on connect, too, so a client
 * that connects mid-run sees the current state without waiting for the
 * next transition) plus best-effort `event` messages forwarding raw
 * AgentExecutor ExecutionEvents for lightweight in-progress visibility.
 *
 * Attached to the same underlying `http.Server` the Express app listens on
 * (see index.ts) via a manual `upgrade` handler, since matching a path
 * with a `:id` param needs a tiny bit of parsing `ws` doesn't do for you.
 */
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import type { RunManager } from './runRegistry';
import { isValidAgentId, type StreamMessage, type LogEntry, type SpanEvent, type DebugStatePayload } from './types';

const STREAM_PATH_RE = /^\/agents\/([^/]+)\/stream$/;

export function attachWebSocketServer(server: HttpServer, runManager: RunManager): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  // agentId -> connected sockets, so status/event broadcasts only fan out
  // to clients watching that one agent's run.
  const subscribers = new Map<string, Set<WebSocket>>();

  function send(ws: WebSocket, message: StreamMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  runManager.on('status', (payload) => {
    const sockets = subscribers.get(payload.agentId);
    if (!sockets) return;
    for (const ws of sockets) send(ws, { type: 'status', payload });
  });

  runManager.on('event', (agentId: string, payload: Record<string, unknown>) => {
    const sockets = subscribers.get(agentId);
    if (!sockets) return;
    for (const ws of sockets) send(ws, { type: 'event', payload });
  });

  // O1/O2/O3: same fan-out pattern as 'status'/'event' above, over the
  // same WS connection - no second channel.
  runManager.on('log', (agentId: string, payload: LogEntry) => {
    const sockets = subscribers.get(agentId);
    if (!sockets) return;
    for (const ws of sockets) send(ws, { type: 'log', payload });
  });

  runManager.on('span', (agentId: string, payload: SpanEvent) => {
    const sockets = subscribers.get(agentId);
    if (!sockets) return;
    for (const ws of sockets) send(ws, { type: 'span', payload });
  });

  runManager.on('debug', (agentId: string, payload: DebugStatePayload) => {
    const sockets = subscribers.get(agentId);
    if (!sockets) return;
    for (const ws of sockets) send(ws, { type: 'debug', payload });
  });

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const match = STREAM_PATH_RE.exec(url.pathname);
    if (!match) {
      socket.destroy();
      return;
    }
    const agentId = decodeURIComponent(match[1]);
    // Same path-traversal boundary as app.ts's `/agents/:id` middleware -
    // this handler parses `:id` itself (see the module doc comment) rather
    // than going through Express routing, so it needs its own check before
    // `agentId` is used as a registry/status key alongside the HTTP routes.
    if (!isValidAgentId(agentId)) {
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

      ws.on('close', () => {
        sockets!.delete(ws);
        if (sockets!.size === 0) subscribers.delete(agentId);
      });
    });
  });

  return wss;
}
