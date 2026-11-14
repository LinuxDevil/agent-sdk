/**
 * Host status routes (W11c): `GET /workspaces/:ws/host` reports which SDK
 * runs the workspace's agents (mode, banner, bridge state, recent stderr
 * on failure); `POST /workspaces/:ws/host/restart` re-runs the bridge
 * handshake for a crashed project bridge.
 *
 * Unlike the `/workspaces/:ws/scan` routes these resolve the `:ws` param
 * through the app's `WorkspaceResolver` - the host lives on the warm
 * `WorkspaceContext`, so the request builds/warms the context exactly
 * like any other workspace-scoped call (the `x-lousho-workspace` header
 * is ignored on purpose: the path names the workspace).
 */
import type { Express, Request, Response } from 'express';
import { WORKSPACE_ID_RE } from '../../shared/workspace';
import type { HostStatus } from '../../shared/wireTypes';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import { hostStatusOf } from '../host/hostStatus';
import type { WorkspaceResolver } from '../workspace/context';

/** Deps for {@link registerHostRoutes}. */
export interface HostRouteDeps {
  /** Resolves `:ws` to a live context (WorkspaceManager, or singleWorkspace in tests). */
  resolver: WorkspaceResolver;
  /** Studio's own SDK `VERSION`, reported as `studioSdkVersion`. */
  studioVersion: string;
}

/**
 * The `:ws` context for a host route, or the error response already sent:
 * a malformed id is 400, an unknown one 404 - same codes the workspace
 * middleware uses for header/query ids.
 */
async function hostContext(req: Request, res: Response, resolver: WorkspaceResolver) {
  const ws = paramId(req, 'ws');
  if (!WORKSPACE_ID_RE.test(ws)) {
    sendError(res, 400, 'Invalid workspace id', 'LOUSHO_WORKSPACE_ID_INVALID');
    return undefined;
  }
  const ctx = await resolver.resolve(ws);
  if (ctx === undefined) {
    sendError(res, 404, `No workspace '${ws}'`, 'LOUSHO_WORKSPACE_NOT_FOUND');
    return undefined;
  }
  return ctx;
}

export function registerHostRoutes(app: Express, deps: HostRouteDeps): void {
  app.get(
    '/workspaces/:ws/host',
    asyncRoute(async (req, res) => {
      const ctx = await hostContext(req, res, deps.resolver);
      if (ctx === undefined) return;
      // Settle the handshake first (bounded by the hello timeout inside
      // BridgeClient) so the answer is the real mode, not the provisional.
      await ctx.hostSelector.ready();
      res.json(hostStatusOf(ctx.ref, ctx.hostSelector, deps.studioVersion) satisfies HostStatus);
    })
  );

  app.post(
    '/workspaces/:ws/host/restart',
    asyncRoute(async (req, res) => {
      const ctx = await hostContext(req, res, deps.resolver);
      if (ctx === undefined) return;
      if (ctx.hostSelector.host.kind !== 'bridge') {
        sendError(res, 409, 'Only a project bridge can be restarted.', 'LOUSHO_HOST_NOT_BRIDGE');
        return;
      }
      await ctx.hostSelector.restart();
      res.status(202).json(hostStatusOf(ctx.ref, ctx.hostSelector, deps.studioVersion) satisfies HostStatus);
    })
  );
}
