/**
 * `WS /agents/:id/stream` - pushes `StreamMessage`s
 * (types.ts) to subscribers of one agent's run: a `status` message on every
 * RunManager status transition (immediately on connect, too, so a client
 * that connects mid-run sees the current state without waiting for the
 * next transition) plus best-effort `event` messages forwarding the run's
 * `AgentEvent`s for lightweight in-progress visibility.
 *
 * Registered on the server's one `UpgradeRouter` (ws/upgradeRouter.ts -
 * the only `upgrade` listener the http.Server has) rather than attaching
 * its own, so the shared Host/Origin/token gate runs once for every WS
 * endpoint; this handler only re-validates the `:id` the RegExp captured,
 * the same boundary app.ts's `/agents/:id` middleware applies.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { RunManager } from './runRegistry';
import { isValidAgentId } from './types';
import type { StreamMessage } from '../shared/wireTypes';
import type { UpgradeRouter } from './ws/upgradeRouter';

const STREAM_PATH_RE = /^\/agents\/([^/]+)\/stream$/;

function send(ws: WebSocket, message: StreamMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * The `:id` `STREAM_PATH_RE` captured, or `undefined` when it fails the
 * same path-traversal boundary as app.ts's `/agents/:id` middleware - this
 * handler parses `:id` itself (it runs outside Express routing) so it
 * needs its own check before the id is used as a registry/status key
 * alongside the HTTP routes.
 */
function streamAgentId(url: URL): string | undefined {
  const match = STREAM_PATH_RE.exec(url.pathname);
  if (!match) return undefined;
  const agentId = decodeURIComponent(match[1]);
  return isValidAgentId(agentId) ? agentId : undefined;
}

export function attachWebSocketServer(router: UpgradeRouter, runManager: RunManager): WebSocketServer {
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

  // 'event' plus 'log'/'span'/'debug', 'chat' (the chat
  // transcript, reconciled from the real ExecutionResult.messages - see
  // chatReconcile.ts) and 'node' (the per-node run states nodeStates.ts
  // derives from `lousho.node.id` spans): same fan-out pattern as
  // 'status', over the same WS connection - no second channel.
  for (const type of ['event', 'log', 'span', 'debug', 'chat', 'node'] as const) {
    runManager.on(type, (agentId: string, payload: unknown) =>
      broadcast(agentId, { type, payload } as StreamMessage)
    );
  }

  router.register(STREAM_PATH_RE, (req, socket, head, url) => {
    const agentId = streamAgentId(url);
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
      // Same for the chat transcript, so opening the Chat tab shows
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
