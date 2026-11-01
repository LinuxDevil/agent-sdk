/**
 * `/workspaces` routes - the REST surface of the workspace registry
 * (workspaceRegistry.ts): `GET/POST /workspaces` and
 * `DELETE /workspaces/:ws`.
 *
 * These are Studio-global routes (like `/settings/secrets`), not
 * per-agent ones: the registry lives at `studioPaths().workspaces`, so
 * the handlers close over the app's one `WorkspaceRegistry` and the
 * launch workspace's id - they never read `workspaceOf(req)`, and a
 * request's `?ws=`/header still resolves to the launch workspace until
 * W02a lands (the middleware answers 404 for any other id).
 *
 * `isLaunch` is a per-process fact (the launch folder can never leave the
 * list while Studio runs) and `available`/`agentCount` reflect the
 * folder's state right now - both are computed per request, never stored
 * in `workspaces.json`. The folder path only ever travels in the POST
 * body, never in a URL (it can name a user's home directory).
 */
import { promises as fsPromises } from 'node:fs';
import type { Express } from 'express';
import type { AddWorkspaceRequest, WorkspaceList, WorkspaceListItem } from '../../shared/wireTypes';
import { WORKSPACE_ID_RE, type WorkspaceRef } from '../../shared/workspace';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import { AgentRepo } from '../storage/agentRepo';
import {
  WorkspaceExistsError,
  WorkspaceInUseError,
  WorkspaceRootError,
  type WorkspaceRegistry,
} from './workspaceRegistry';

export interface WorkspaceRegistryRouteDeps {
  /** The app's one registry (built over `studioPaths().workspaces` at wiring time). */
  registry: WorkspaceRegistry;
  /** The launch workspace's id - `GET`'s `defaultId` and the one entry `DELETE` refuses. */
  launchId: string;
}

/**
 * `ref` plus the per-request facts: `available` stats the folder right
 * now (a moved or unmounted folder reads `false` instead of failing the
 * whole list) and `agentCount` counts its `.lousho/agents/*.yaml` files.
 */
async function toListItem(ref: WorkspaceRef, launchId: string): Promise<WorkspaceListItem> {
  const stat = await fsPromises.stat(ref.root).catch(() => undefined);
  const available = stat?.isDirectory() === true;
  return {
    ...ref,
    isLaunch: ref.id === launchId,
    available,
    agentCount: available ? new AgentRepo(ref.root).listIds().length : 0,
  };
}

/** The list order `GET /workspaces` answers in: by name (case-insensitive), then id for a stable tie-break. */
function byNameThenId(a: WorkspaceListItem, b: WorkspaceListItem): number {
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id);
}

/** Registers the three registry routes on `app`; mounted next to `registerWorkspaceRoute` in `createApp`. */
export function registerWorkspaceRegistryRoutes(app: Express, deps: WorkspaceRegistryRouteDeps): void {
  const { registry, launchId } = deps;

  // The workspace switcher's/Settings card's list: every registered
  // workspace plus the per-request availability facts, `defaultId` naming
  // the launch workspace.
  app.get(
    '/workspaces',
    asyncRoute(async (_req, res) => {
      const refs = await registry.list();
      const workspaces = await Promise.all(refs.map((ref) => toListItem(ref, launchId)));
      workspaces.sort(byNameThenId);
      const body: WorkspaceList = { defaultId: launchId, workspaces };
      res.json(body);
    })
  );

  // "Add workspace → folder path": validates and appends, answering the
  // new row; 400 for a bad/missing/non-folder path, 409 for a duplicate.
  app.post(
    '/workspaces',
    asyncRoute(async (req, res) => {
      const { root } = req.body as AddWorkspaceRequest;
      try {
        const ref = await registry.add(root);
        res.status(201).json(await toListItem(ref, launchId));
      } catch (error) {
        if (error instanceof WorkspaceRootError) {
          sendError(res, error.status, error.message, error.code);
          return;
        }
        if (error instanceof WorkspaceExistsError) {
          sendError(res, 409, error.message, error.code, { id: error.existing.id });
          return;
        }
        throw error;
      }
    })
  );

  // Removes the registry entry only - the folder on disk is never
  // touched. The launch workspace is always refused (it stays in the
  // list while Studio runs), an unknown id is a 404.
  app.delete(
    '/workspaces/:ws',
    asyncRoute(async (req, res) => {
      const ws = paramId(req, 'ws');
      if (!WORKSPACE_ID_RE.test(ws)) {
        sendError(res, 400, 'Invalid workspace id', 'LOUSHO_WORKSPACE_ID_INVALID');
        return;
      }
      if (ws === launchId) {
        const inUse = new WorkspaceInUseError();
        sendError(res, 409, inUse.message, inUse.code);
        return;
      }
      if (!(await registry.remove(ws))) {
        sendError(res, 404, `No workspace '${ws}'`, 'LOUSHO_WORKSPACE_NOT_FOUND');
        return;
      }
      res.status(204).end();
    })
  );
}
