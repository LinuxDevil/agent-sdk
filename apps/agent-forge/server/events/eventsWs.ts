/**
 * `WS /events` - pushes every `StudioEvent` published on the workspace's
 * `StudioEventBus` to every connected tab, as JSON text frames. Nothing
 * is sent on connect: events are live notifications only (a client that
 * missed one re-reads the REST state it refreshes).
 *
 * `?ws=<id>` picks the workspace (W02b - browsers cannot set the
 * `x-lousho-workspace` header on a WebSocket); missing it means the
 * default workspace. The resolved context's `retain` keeps it warm until
 * the socket closes.
 *
 * Registered on the server's one `UpgradeRouter` (ws/upgradeRouter.ts),
 * so the shared Host/Origin/token gate runs before this handler - the
 * `?token=` query the gate checks rides along on the WS URL.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { StudioEvent } from '../../shared/wireTypes';
import type { UpgradeRouter } from '../ws/upgradeRouter';
import type { WorkspaceResolver } from '../workspace/context';
import { rejectUpgradeWith, resolveWsWorkspace } from '../workspace/wsWorkspace';
import { cleanupOnClose } from '../ws/cleanupOnClose';

/** The exact pathname `WS /events` registers on the upgrade router. */
const EVENTS_PATH = '/events';

/**
 * Registers `WS /events` on `router`: each accepted socket subscribes to
 * its workspace's event bus until it closes. Returns the (noServer)
 * WebSocketServer so the caller can close it with the http server.
 */
export function attachEventsWebSocket(router: UpgradeRouter, workspaces: WorkspaceResolver): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  router.register(EVENTS_PATH, (req, socket, head, url) => {
    void resolveWsWorkspace(url, workspaces)
      .then((result) => {
        if (!result.ok) {
          rejectUpgradeWith(socket, result.status);
          return;
        }
        const { ctx } = result;
        const release = workspaces.retain(ctx.ref.id);
        socket.once('close', release);
        wss.handleUpgrade(req, socket, head, (ws) => {
          const unsubscribe = ctx.events.subscribe((event: StudioEvent) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
          });
          cleanupOnClose(ws, () => {
            unsubscribe();
            release();
          });
        });
      })
      .catch(() => socket.destroy());
  });
  return wss;
}
