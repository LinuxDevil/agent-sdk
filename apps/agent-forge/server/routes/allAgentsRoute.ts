/**
 * `GET /agents?ws=all` (or `x-lousho-workspace: all`) - every registered
 * workspace's agents in one `AllAgentsResponse` (PLAN §19.6, W06a).
 *
 * Registered BEFORE `registerAgentRoutes`: its `/agents` GET intercepts
 * only the `ALL_WORKSPACES` request and calls `next()` for everything
 * else, so the single-workspace route is untouched.
 *
 * Warm workspaces (the `WorkspaceManager`'s live contexts) read through
 * their real `WorkspaceContext` - `runStatus` included, so a running
 * agent still reports `lastRun.status: 'running'`. Cold workspaces get a
 * bare `new AgentRepo(root)` - read-only, no RunManager is built - so an
 * aggregate request never spins up a workspace context just to list.
 * W07a/W08a extend `listAllAgents` with observed and code agents.
 */
import { statSync } from 'node:fs';
import type { Express, NextFunction, Request, Response } from 'express';
import { ALL_WORKSPACES, type WorkspaceRef } from '../../shared/workspace';
import type { AgentListItem, AllAgentsResponse, WorkspaceAgentItem } from '../../shared/wireTypes';
import { sendError } from '../http/routeUtils';
import { AgentRepo } from '../storage/agentRepo';
import { buildAgentListItems } from './agentListItems';
import { requestedWorkspaceId } from '../workspace/middleware';
import type { WorkspaceContext } from '../workspace/context';
import type { WorkspaceRegistry } from '../workspace/workspaceRegistry';

export interface AllAgentsDeps {
  registry: WorkspaceRegistry;
  /** The warm contexts (`WorkspaceManager.warm()`); the launch context is always among them. */
  warm: () => WorkspaceContext[];
}

interface WorkspaceRead {
  items: AgentListItem[];
  skipped?: { workspaceId: string; reason: string };
}

/** `ref.root` still a directory? A moved or unmounted folder is skipped up front with an honest reason. */
function rootIsDirectory(ref: WorkspaceRef): boolean {
  try {
    return statSync(ref.root).isDirectory();
  } catch {
    return false;
  }
}

async function readWorkspace(ref: WorkspaceRef, warm: Map<string, WorkspaceContext>): Promise<WorkspaceRead> {
  const ctx = warm.get(ref.id);
  try {
    const items =
      ctx !== undefined
        ? await buildAgentListItems({ repo: ctx.repo, root: ctx.ref.root, runStatus: (id) => ctx.runs.status(id) })
        : await buildAgentListItems({ repo: new AgentRepo(ref.root), root: ref.root });
    return { items };
  } catch (error) {
    console.warn(`[agent-forge] skipping workspace '${ref.id}' in the aggregate agent list: ${(error as Error).message}`);
    return { items: [], skipped: { workspaceId: ref.id, reason: (error as Error).message } };
  }
}

/** The aggregate list (W07a/W08a extend it with the other agent kinds). */
// fallow-ignore-next-line unused-export -- W06a contract export; W06b's aggregate screen and W07a/W08a consume it
export async function listAllAgents(deps: AllAgentsDeps): Promise<AllAgentsResponse> {
  const refs = await deps.registry.list();
  const warm = new Map(deps.warm().map((ctx) => [ctx.ref.id, ctx]));
  const reads = await Promise.all(
    refs.map(async (ref) => ({
      ref,
      read: rootIsDirectory(ref) ? await readWorkspace(ref, warm) : { items: [], skipped: { workspaceId: ref.id, reason: 'Folder not found' } },
    }))
  );

  const nameOf = new Map(refs.map((ref) => [ref.id, ref.name.toLowerCase()]));
  const items: WorkspaceAgentItem[] = [];
  const skipped: AllAgentsResponse['skipped'] = [];
  for (const { ref, read } of reads) {
    if (read.skipped !== undefined) {
      skipped.push(read.skipped);
      continue;
    }
    for (const item of read.items) items.push({ ...item, kind: 'workspace', workspaceId: ref.id });
  }
  items.sort((a, b) => {
    const byWs = (nameOf.get(a.workspaceId) ?? '').localeCompare(nameOf.get(b.workspaceId) ?? '');
    if (byWs !== 0) return byWs;
    const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return byName !== 0 ? byName : a.id.localeCompare(b.id);
  });
  return { items, skipped };
}

/**
 * Answers `GET /agents` when the request's workspace is `all`; calls
 * `next()` for every other workspace so `registerAgentRoutes`' own
 * `/agents` GET still owns them. `?view=legacy` with `ws=all` is a 400 -
 * the legacy view lists one workspace only.
 */
export function registerAllAgentsRoute(app: Express, deps: AllAgentsDeps): void {
  app.get('/agents', (req: Request, res: Response, next: NextFunction) => {
    if (requestedWorkspaceId(req) !== ALL_WORKSPACES) {
      next();
      return;
    }
    if (req.query.view === 'legacy') {
      sendError(res, 400, 'The legacy view lists one workspace only.', 'LOUSHO_BODY_INVALID');
      return;
    }
    listAllAgents(deps).then(
      (body) => res.json(body),
      (error: unknown) => next(error),
    );
  });
}
