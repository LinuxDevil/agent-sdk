/**
 * The ONE `upgrade` listener on Studio's `http.Server`.
 *
 * Two `upgrade` listeners on one server both fire for every request, so
 * giving each WS endpoint its own listener means the wrong one destroys
 * the other's paths. Instead, `createUpgradeRouter` owns the single
 * listener; every WS endpoint (`/agents/:id/stream`, `/events`, later
 * `/assistant/stream`) registers a route on it. On each upgrade the
 * router runs the shared Host/Origin/token gate (the same checks the HTTP
 * API applies - see auth.ts) before any handler, parses the URL once,
 * then dispatches by pathname to the first registered route that matches
 * (registration order). An unmatched path's socket is destroyed.
 */
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { checkApiAccess, checkHostAndOrigin, type StudioAccessOptions } from '../auth';

/** One WS endpoint's upgrade handler: completes the upgrade itself (its own `WebSocketServer({ noServer: true })`) or destroys the socket. */
export type UpgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer, url: URL) => void;

/** The registry `createUpgradeRouter` returns - each WS endpoint calls `register` exactly once. */
export interface UpgradeRouter {
  /**
   * `path` is an exact pathname ('/events', '/assistant/stream') or a
   * RegExp matched against the pathname ('/^\\/agents\\/([^/]+)\\/stream$/')
   * - matching never sees the query string, which stays on `url` for the
   * handler. Throws on a duplicate route (same string, or a RegExp with
   * the same source and flags).
   */
  register(path: string | RegExp, handler: UpgradeHandler): void;
}

interface UpgradeRoute {
  path: string | RegExp;
  handler: UpgradeHandler;
}

/**
 * The shared Host/Origin/token gate as the HTTP API applies it (see
 * auth.ts); omitted `access` skips only the token. Writes the HTTP
 * rejection straight to the socket and answers `true` when the upgrade
 * must go no further.
 */
function rejectUpgrade(req: IncomingMessage, socket: Socket, access: StudioAccessOptions | undefined): boolean {
  const decision = access ? checkApiAccess(req, access) : checkHostAndOrigin(req, { token: '' });
  if (decision.ok) return false;
  const reason = decision.status === 401 ? 'Unauthorized' : 'Forbidden';
  const CRLF = '\r\n';
  socket.end(`HTTP/1.1 ${decision.status} ${reason}${CRLF}Connection: close${CRLF}Content-Length: 0${CRLF}${CRLF}`);
  return true;
}

function sameRoute(a: string | RegExp, b: string | RegExp): boolean {
  if (typeof a !== typeof b) return false;
  return typeof a === 'string' ? a === b : a.source === (b as RegExp).source && a.flags === (b as RegExp).flags;
}

/**
 * Attaches the single `upgrade` listener to `server` and returns the
 * router every WS endpoint registers on. The listener runs the shared
 * gate first - a rejection is written before any handler runs - then the
 * first matching route gets the upgrade; no match destroys the socket.
 */
export function createUpgradeRouter(server: HttpServer, access?: StudioAccessOptions): UpgradeRouter {
  const routes: UpgradeRoute[] = [];
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (rejectUpgrade(req, socket, access)) return;
    const url = new URL(req.url ?? '', 'http://localhost');
    const route = routes.find((r) =>
      typeof r.path === 'string' ? r.path === url.pathname : r.path.test(url.pathname)
    );
    if (!route) {
      socket.destroy();
      return;
    }
    route.handler(req, socket, head, url);
  });
  return {
    register(path, handler) {
      if (routes.some((r) => sameRoute(r.path, path))) {
        throw new Error(`Duplicate WS upgrade route '${String(path)}'`);
      }
      routes.push({ path, handler });
    },
  };
}
