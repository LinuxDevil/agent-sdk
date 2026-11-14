/**
 * `AgentListItem[]` building, shared by `GET /agents` (one workspace,
 * agentRoutes.ts) and `GET /agents?ws=all` (allAgentsRoute.ts, W06a).
 *
 * `AgentListSource` is deliberately repo-level, not `WorkspaceContext`:
 * the aggregate route builds the same items for COLD workspaces with a
 * bare `new AgentRepo(root)` and no RunManager - `runStatus` is simply
 * absent there, so `lastRun` falls back to the newest persisted trace.
 */
import type { AgentSpecV2 } from 'lousho';
import type { AgentLastRun, AgentListItem, AgentRunStatusPayload } from '../../shared/wireTypes';
import type { AgentRepo } from '../storage/agentRepo';
import { listAgentTraces } from '../traceStore';

export interface AgentListSource {
  repo: AgentRepo;
  /** The workspace root `listAgentTraces` reads run traces under. */
  root: string;
  /** Live run status per agent id - present only for warm workspaces (a cold one has no RunManager). */
  runStatus?: (agentId: string) => AgentRunStatusPayload;
}

/** The `counts` an `AgentListItem` carries: section sizes read off the spec as data. */
function countsOf(spec: AgentSpecV2): AgentListItem['counts'] {
  return {
    tools: spec.tools?.length ?? 0,
    mcpServers: Object.keys(spec.mcpServers ?? {}).length,
    subagents: Object.keys(spec.subagents ?? {}).length,
    triggers: spec.triggers?.length ?? 0,
  };
}

/**
 * The `lastRun` of an `AgentListItem`: the live status while a run is not
 * `idle` (warm workspaces only - `runStatus` absent means no RunManager),
 * else the newest persisted trace's outcome, else `undefined` when the
 * agent has never run.
 */
async function lastRunOf(source: AgentListSource, id: string): Promise<AgentLastRun | undefined> {
  const live = source.runStatus?.(id);
  if (live !== undefined && live.status !== 'idle') {
    return { status: live.status, at: live.updatedAt, ...(live.traceId !== undefined && { traceId: live.traceId }) };
  }
  const [trace] = await listAgentTraces(source.root, id, 1);
  if (trace === undefined) return undefined;
  return {
    status: trace.status === 'error' ? 'error' : 'done',
    at: new Date(trace.startTime + trace.durationMs).toISOString(),
    traceId: trace.traceId,
  };
}

/** One agent's `AgentListItem`; `undefined` when the id has no spec (it can disappear mid-list). */
async function toListItem(source: AgentListSource, id: string): Promise<AgentListItem | undefined> {
  const spec = await source.repo.readSpec(id);
  if (spec === undefined) return undefined;
  const [meta, lastRun] = await Promise.all([source.repo.readMeta(id), lastRunOf(source, id)]);
  return {
    id,
    name: spec.name,
    description: spec.description ?? '',
    model: spec.model,
    enabled: meta.enabled,
    disabledReason: meta.disabledReason,
    labels: meta.labels,
    updatedAt: source.repo.updatedAt(id),
    publishedVersion: meta.publishedVersion,
    ...(lastRun !== undefined && { lastRun }),
    counts: countsOf(spec),
  };
}

/**
 * Every readable agent's `AgentListItem`, sorted by id (D06a's order -
 * the aggregate route re-sorts across workspaces itself). Unreadable
 * specs are skipped with a `console.warn`, as `GET /agents` always did.
 */
export async function buildAgentListItems(source: AgentListSource): Promise<AgentListItem[]> {
  const items = await Promise.all(
    source.repo.listIds().map(async (id) => {
      try {
        return await toListItem(source, id);
      } catch (error) {
        console.warn(`[agent-forge] skipping unreadable agent spec '${id}': ${(error as Error).message}`);
        return undefined;
      }
    })
  );
  return items.filter((item): item is AgentListItem => item !== undefined);
}
