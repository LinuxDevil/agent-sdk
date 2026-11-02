/**
 * `WS /events` - pushes every `StudioEvent` published on the workspace's
 * `StudioEventBus` to every connected tab, as JSON text frames. Nothing
 * is sent on connect: events are live notifications only (a client that
 * missed one re-reads the REST state it refreshes).
 *
 * Registered on the server's one `UpgradeRouter` (ws/upgradeRouter.ts),
 * so the shared Host/Origin/token gate runs before this handler - the
 * `?token=` query the gate checks rides along on the WS URL.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { StudioEvent } from '../../shared/wireTypes';
import type { UpgradeRouter } from '../ws/upgradeRouter';
import type { StudioEventBus } from './eventBus';

/** The exact pathname `WS /events` registers on the upgrade router. */
const EVENTS_PATH = '/events';

/**
 * Registers `WS /events` on `router`: each accepted socket subscribes to
 * `events` until it closes. Returns the (noServer) WebSocketServer so the
 * caller can close it with the http server.
 */
export function attachEventsWebSocket(router: UpgradeRouter, events: StudioEventBus): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  router.register(EVENTS_PATH, (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const unsubscribe = events.subscribe((event: StudioEvent) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
      });
      ws.on('close', unsubscribe);
    });
  });
  return wss;
}
