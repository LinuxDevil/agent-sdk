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
import type { AgentListItem, AllAgentsResponse, AnyAgentItem, CodeAgentItem } from '../../shared/wireTypes';
import { sendError } from '../http/routeUtils';
import { AgentRepo } from '../storage/agentRepo';
import { buildAgentListItems } from './agentListItems';
import { fetchDaemonAgents, toObservedItems, type WorkspaceMatch } from '../observed/observedAgents';
import { observeProjectOf } from '../observed/observeProject';
import { requestedWorkspaceId } from '../workspace/middleware';
import type { CodeAgentCache } from '../workspace/codeAgentScan';
import type { WorkspaceContext } from '../workspace/context';
import type { WorkspaceEntry, WorkspaceRegistry } from '../workspace/workspaceRegistry';

export interface AllAgentsDeps {
  registry: WorkspaceRegistry;
  /** The warm contexts (`WorkspaceManager.warm()`); the launch context is always among them. */
  warm: () => WorkspaceContext[];
  /** The app's one code-agent scan cache (W08a); each listed workspace contributes its scanned code agents. */
  codeAgents: CodeAgentCache;
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

/**
 * The aggregate's code agents (W08a): each successfully-read workspace's
 * cached-or-fresh pattern scan contributes `CodeAgentItem`s. A code dir
 * whose `name` equals a Studio agent id in the same workspace is omitted
 * - the Studio copy wins. A failed scan drops that workspace's code
 * items only (warned, never fatal to the list).
 */
async function codeAgentItems(
  matches: WorkspaceMatch[],
  entries: Map<string, WorkspaceEntry>,
  nameOf: Map<string, string>,
  cache: CodeAgentCache
): Promise<CodeAgentItem[]> {
  const items: CodeAgentItem[] = [];
  for (const match of matches) {
    const entry = entries.get(match.id);
    if (entry === undefined) continue;
    try {
      const scan = cache.get(entry.id) ?? (await cache.scan(entry));
      for (const dir of scan.agents) {
        if (match.agentIds.has(dir.name)) continue;
        items.push({
          kind: 'code',
          id: dir.path,
          name: dir.name,
          workspaceId: entry.id,
          configFile: dir.configFile,
          configKind: dir.configKind,
        });
      }
    } catch (error) {
      console.warn(`[agent-forge] skipping code agents for workspace '${entry.id}' in the aggregate agent list: ${(error as Error).message}`);
    }
  }
  return items.sort((a, b) => {
    const byWs = (nameOf.get(a.workspaceId) ?? '').localeCompare(nameOf.get(b.workspaceId) ?? '');
    if (byWs !== 0) return byWs;
    return a.id.localeCompare(b.id);
  });
}

/** The aggregate list (W07a/W08a: workspace + observed + code agents). */
// fallow-ignore-next-line unused-export -- W06a contract export; W06b's aggregate screen and W07a/W08a consume it
export async function listAllAgents(deps: AllAgentsDeps): Promise<AllAgentsResponse> {
  const refs = await deps.registry.list();
  const warm = new Map(deps.warm().map((ctx) => [ctx.ref.id, ctx]));
  // The daemon read runs in parallel with the workspace reads; `undefined`
  // means unavailable (down/timeout/bad body) -> `observed: 'unavailable'`.
  const observedRowsPromise = fetchDaemonAgents();
  const reads = await Promise.all(
    refs.map(async (ref) => ({
      ref,
      read: rootIsDirectory(ref) ? await readWorkspace(ref, warm) : { items: [], skipped: { workspaceId: ref.id, reason: 'Folder not found' } },
    }))
  );

  const observedRows = await observedRowsPromise;
  const nameOf = new Map(refs.map((ref) => [ref.id, ref.name.toLowerCase()]));
  const items: AnyAgentItem[] = [];
  const skipped: AllAgentsResponse['skipped'] = [];
  // W07a: each successfully-read workspace also feeds the observed
  // placement - its projects (id + package name) and the agent ids just
  // listed (Studio's own daemon rows are filtered against them).
  const matches: WorkspaceMatch[] = [];
  for (const { ref, read } of reads) {
    if (read.skipped !== undefined) {
      skipped.push(read.skipped);
      continue;
    }
    for (const item of read.items) items.push({ ...item, kind: 'workspace', workspaceId: ref.id });
    matches.push({
      id: ref.id,
      projects: new Set([ref.id, observeProjectOf(ref.root)]),
      agentIds: new Set(read.items.map((item) => item.id)),
    });
  }
  items.sort((a, b) => {
    if (a.kind !== 'workspace' || b.kind !== 'workspace') return 0;
    const byWs = (nameOf.get(a.workspaceId) ?? '').localeCompare(nameOf.get(b.workspaceId) ?? '');
    if (byWs !== 0) return byWs;
    const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return byName !== 0 ? byName : a.id.localeCompare(b.id);
  });

  // Observed agents (W07a): fetched in parallel with the workspace reads
  // above would have been ideal; the daemon call is independent so it
  // runs alongside `reads` via Promise.all at the call site instead -
  // here we await it (it was kicked off before the reads resolved).
  const observedItems = observedRows === undefined ? [] : toObservedItems(observedRows, matches);
  const placed = observedItems.filter((item) => item.workspaceId !== null);
  const elsewhere = observedItems.filter((item) => item.workspaceId === null);
  placed.sort((a, b) => {
    const byWs = (nameOf.get(a.workspaceId ?? '') ?? '').localeCompare(nameOf.get(b.workspaceId ?? '') ?? '');
    if (byWs !== 0) return byWs;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id);
  });

  // Code agents (W08a) sort after the workspace's own and observed items.
  const entries = new Map(refs.map((ref) => [ref.id, ref]));
  const codeItems = await codeAgentItems(matches, entries, nameOf, deps.codeAgents);
  return { items: [...items, ...placed, ...elsewhere, ...codeItems], skipped, observed: observedRows === undefined ? 'unavailable' : 'ok' };
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
