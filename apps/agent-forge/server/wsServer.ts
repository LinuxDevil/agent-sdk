/**
 * `WS /agents/:id/stream` - pushes `StreamMessage`s
 * (types.ts) to subscribers of one agent's run: a `status` message on every
 * RunManager status transition (immediately on connect, too, so a client
 * that connects mid-run sees the current state without waiting for the
 * next transition) plus best-effort `event` messages forwarding the run's
 * `AgentEvent`s for lightweight in-progress visibility.
 *
 * `?ws=<id>` picks the workspace (W02b - browsers cannot set the
 * `x-lousho-workspace` header on a WebSocket); missing it means the
 * default workspace. The resolved context's `retain` keeps it warm until
 * the socket closes, and its listeners come off `ctx.runs` on close so a
 * reconnect never doubles them.
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
import type { WorkspaceResolver } from './workspace/context';
import { rejectUpgradeWith, resolveWsWorkspace } from './workspace/wsWorkspace';
import { cleanupOnClose } from './ws/cleanupOnClose';

const STREAM_PATH_RE = /^\/agents\/([^/]+)\/stream$/;

/** The RunManager event names forwarded to the socket as `StreamMessage`s (plus 'status'). */
const FORWARDED_EVENTS = ['event', 'log', 'span', 'debug', 'chat', 'node'] as const;

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

export function attachWebSocketServer(router: UpgradeRouter, workspaces: WorkspaceResolver): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  router.register(STREAM_PATH_RE, (req, socket, head, url) => {
    const agentId = streamAgentId(url);
    if (!agentId) {
      socket.destroy();
      return;
    }
    // Async: the workspace resolves (and may build) before the upgrade -
    // a refusal is a plain HTTP answer, never a `ws` handshake.
    void resolveWsWorkspace(url, workspaces).then((result) => {
      if (!result.ok) {
        rejectUpgradeWith(socket, result.status);
        return;
      }
      // `all` is only reachable with allowAll, which this endpoint never
      // passes - the guard keeps the union narrow for `ctx`.
      if (result.all === true) {
        socket.destroy();
        return;
      }
      const { ctx } = result;
      const runs = ctx.runs;
      // Held from the resolved context until the socket is gone - sweep()
      // never disposes a workspace with an open stream. `retain`'s release
      // is idempotent, so socket + ws close both firing is safe.
      const release = workspaces.retain(ctx.ref.id);
      socket.once('close', release);
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Per-socket listeners on THIS workspace's RunManager: status and
        // the forwarded run events for the watched agent only, removed on
        // close so reconnects never stack duplicates.
        const onStatus = (payload: ReturnType<RunManager['status']>) => {
          if (payload.agentId === agentId) send(ws, { type: 'status', payload });
        };
        const detach: Array<() => void> = [() => runs.off('status', onStatus)];
        runs.on('status', onStatus);
        // 'event' plus 'log'/'span'/'debug', 'chat' (the chat
        // transcript, reconciled from the real ExecutionResult.messages - see
        // chatReconcile.ts) and 'node' (the per-node run states nodeStates.ts
        // derives from `lousho.node.id` spans): same fan-out pattern as
        // 'status', over the same WS connection - no second channel.
        for (const type of FORWARDED_EVENTS) {
          const onEvent = (eventAgentId: string, payload: unknown) => {
            if (eventAgentId === agentId) send(ws, { type, payload } as StreamMessage);
          };
          runs.on(type, onEvent);
          detach.push(() => runs.off(type, onEvent));
        }

        // Send current status immediately so a client connecting mid-run (or
        // after a pause) doesn't have to wait for the next transition.
        send(ws, { type: 'status', payload: runs.status(agentId) });
        // Same for the chat transcript, so opening the Chat tab shows
        // history immediately rather than waiting for the next message.
        send(ws, { type: 'chat', payload: runs.chatState(agentId) });

        cleanupOnClose(ws, () => {
          for (const off of detach) off();
          release();
        });
      });
    }).catch(() => socket.destroy());
  });

  return wss;
}
