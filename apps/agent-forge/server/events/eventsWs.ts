/**
 * `WS /events` - pushes every `StudioEvent` published on the workspace's
 * `StudioEventBus` to every connected tab, as JSON text frames. Nothing
 * is sent on connect for a single workspace: events are live
 * notifications only (a client that missed one re-reads the REST state
 * it refreshes).
 *
 * `?ws=<id>` picks the workspace (W02b - browsers cannot set the
 * `x-lousho-workspace` header on a WebSocket); missing it means the
 * default workspace. The resolved context's `retain` keeps it warm until
 * the socket closes.
 *
 * `?ws=all` (W09a) is the aggregate stream: every warm context's events
 * forwarded tagged with its `workspaceId`, contexts built later joined
 * through `onBuilt` and dropped through `onDisposed`, plus a Studio-wide
 * `inbox.count` frame (`workspaceId: 'all'`) on connect and whenever the
 * total changed. `retain` is deliberately NOT taken - watching every
 * workspace must not keep them all warm.
 *
 * Registered on the server's one `UpgradeRouter` (ws/upgradeRouter.ts),
 * so the shared Host/Origin/token gate runs before this handler - the
 * `?token=` query the gate checks rides along on the WS URL.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { AllEventsFrame, StudioEvent } from '../../shared/wireTypes';
import type { UpgradeRouter } from '../ws/upgradeRouter';
import type { WorkspaceContext, WorkspaceResolver } from '../workspace/context';
import { rejectUpgradeWith, resolveWsWorkspace } from '../workspace/wsWorkspace';
import { cleanupOnClose } from '../ws/cleanupOnClose';
import { countAllInbox, type InboxAggregateDeps } from '../inbox/inboxAggregate';

/** The exact pathname `WS /events` registers on the upgrade router. */
const EVENTS_PATH = '/events';

/** Trailing debounce for aggregate `inbox.count` recomputes, per socket. */
const COUNT_DEBOUNCE_MS = 250;

/** What the `?ws=all` branch needs beyond the resolver: the aggregate's deps plus the manager's build/dispose hooks. */
export interface AllEventsDeps extends InboxAggregateDeps {
  /** `WorkspaceManager.onBuilt` - contexts joining the warm set after connect. */
  onBuilt?: (listener: (ctx: WorkspaceContext) => void) => () => void;
  /** `WorkspaceManager.onDisposed` - contexts leaving the warm set. */
  onDisposed?: (listener: (id: string) => void) => () => void;
}

/**
 * The aggregate attach: subscribes every warm context's bus, follows
 * `onBuilt`/`onDisposed`, forwards each event tagged with its
 * `workspaceId`, and republishes the Studio-wide inbox count. Everything
 * unsubscribes on socket close - contexts outlive sockets.
 */
function attachAllEvents(ws: WebSocket, deps: AllEventsDeps): void {
  const subscriptions = new Map<string, () => void>();
  let lastCount: number | undefined;
  let countTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (frame: AllEventsFrame) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };

  const recomputeCount = async () => {
    const count = await countAllInbox(deps).catch(() => undefined);
    if (count === undefined || count === lastCount) return;
    lastCount = count;
    send({ type: 'inbox.count', count, workspaceId: 'all' });
  };
  const scheduleCount = () => {
    if (countTimer !== undefined) clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      countTimer = undefined;
      void recomputeCount();
    }, COUNT_DEBOUNCE_MS);
    countTimer.unref?.();
  };

  const attach = (ctx: WorkspaceContext) => {
    if (subscriptions.has(ctx.ref.id)) return;
    subscriptions.set(
      ctx.ref.id,
      ctx.events.subscribe((event: StudioEvent) => {
        send({ ...event, workspaceId: ctx.ref.id });
        if (event.type === 'inbox.count') scheduleCount();
      })
    );
  };
  const detach = (id: string) => {
    subscriptions.get(id)?.();
    subscriptions.delete(id);
  };

  for (const ctx of deps.warm()) attach(ctx);
  const offBuilt = deps.onBuilt?.(attach);
  const offDisposed = deps.onDisposed?.(detach);

  // The connect-time total frame; later ones ride the debounced recompute.
  void recomputeCount();

  cleanupOnClose(ws, () => {
    if (countTimer !== undefined) clearTimeout(countTimer);
    offBuilt?.();
    offDisposed?.();
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
  });
}

/**
 * Registers `WS /events` on `router`: each accepted socket subscribes to
 * its workspace's event bus until it closes. `aggregate` (W09a) enables
 * the `?ws=all` branch; without it `all` stays a 400. Returns the
 * (noServer) WebSocketServer so the caller can close it with the http
 * server.
 */
export function attachEventsWebSocket(
  router: UpgradeRouter,
  workspaces: WorkspaceResolver,
  aggregate?: AllEventsDeps
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  router.register(EVENTS_PATH, (req, socket, head, url) => {
    void resolveWsWorkspace(url, workspaces, { allowAll: aggregate !== undefined })
      .then((result) => {
        if (!result.ok) {
          rejectUpgradeWith(socket, result.status);
          return;
        }
        if (result.all === true) {
          wss.handleUpgrade(req, socket, head, (ws) => {
            if (aggregate !== undefined) attachAllEvents(ws, aggregate);
          });
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
