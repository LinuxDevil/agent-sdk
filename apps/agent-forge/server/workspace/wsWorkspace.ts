/**
 * `?ws=` resolution for WebSocket upgrades (W02b).
 *
 * Browsers cannot set headers on a `WebSocket`, so the upgrade URL's
 * `?ws=<id>` query is the only way a stream names its workspace - the
 * `x-lousho-workspace` header has no WS equivalent. Missing `ws` means
 * the default (launch) workspace, exactly like an HTTP request with no
 * workspace id; `all` is rejected here because there is no aggregate
 * stream (W09a adds `GET /events?ws=all`-style multiplexing later).
 *
 * Validation mirrors `workspaceMiddleware`: a malformed id (or `?ws=`
 * given twice) is a 400 and a well-formed but unknown one a 404 - the
 * upgrade is answered with a plain HTTP status before `handleUpgrade`
 * ever runs, the same style the auth gate's rejections use.
 */
import type { Socket } from 'node:net';
import { ALL_WORKSPACES, WORKSPACE_ID_RE, WORKSPACE_QUERY } from '../../shared/workspace';
import type { WorkspaceContext, WorkspaceResolver } from './context';

export type WsWorkspaceResult =
  | { ok: true; ctx: WorkspaceContext }
  | { ok: false; status: 400 | 404; error: string };

const REASONS: Record<400 | 404, string> = { 400: 'Bad Request', 404: 'Not Found' };

/**
 * The workspace a WS upgrade URL asks for. `undefined`/missing `ws` →
 * the resolver's default; `all` → 400 (no aggregate stream yet); a
 * malformed or repeated id → 400; an unknown one → 404.
 */
export async function resolveWsWorkspace(url: URL, workspaces: WorkspaceResolver): Promise<WsWorkspaceResult> {
  const values = url.searchParams.getAll(WORKSPACE_QUERY);
  if (values.length > 1) {
    return { ok: false, status: 400, error: 'Invalid workspace id' };
  }
  const id = values[0];
  if (id === undefined) {
    const ctx = await workspaces.resolve(undefined);
    return ctx === undefined ? { ok: false, status: 404, error: 'No workspace' } : { ok: true, ctx };
  }
  if (id === ALL_WORKSPACES) {
    return { ok: false, status: 400, error: 'Aggregate workspace streams are not supported' };
  }
  if (!WORKSPACE_ID_RE.test(id)) {
    return { ok: false, status: 400, error: 'Invalid workspace id' };
  }
  const ctx = await workspaces.resolve(id);
  return ctx === undefined ? { ok: false, status: 404, error: `No workspace '${id}'` } : { ok: true, ctx };
}

/** Answers a refused upgrade with `HTTP/1.1 <status>` then destroys the socket (the auth gate's rejection style). */
export function rejectUpgradeWith(socket: Socket, status: 400 | 404): void {
  socket.end(`HTTP/1.1 ${status} ${REASONS[status]}\r\n\r\n`);
}
