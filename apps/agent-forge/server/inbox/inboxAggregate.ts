/**
 * The `?ws=all` inbox (W09a, PLAN §19.6/§6.2): one list of everything
 * waiting on the user across every registered workspace, and the
 * Studio-wide count `WS /events?ws=all` republishes.
 *
 * Warm workspaces answer through their live `InboxService` (approvals,
 * questions, drafts, suggestions - alerts filtered out, since the alert
 * store is Studio-global and listed once below). Cold workspaces have no
 * RunManager to pause on, so they contribute only the disk-only sources -
 * pending drafts and open suggestions - read through throwaway
 * `DraftStore`/`SuggestionStore`s over a bare `AgentRepo`; listing never
 * builds a context. Every undismissed alert then appears exactly once,
 * whichever workspace it names. The merge sorts by the per-workspace
 * contract order (`compareInboxItems`).
 */
import { AgentRepo } from '../storage/agentRepo';
import { DraftStore } from '../storage/draftStore';
import { SuggestionStore } from '../storage/suggestionStore';
import type { InboxItem, WorkspaceInboxItem } from '../../shared/wireTypes';
import type { AlertStore } from './alertStore';
import {
  agentNamesOf,
  alertItem,
  compareInboxItems,
  draftInboxItems,
  suggestionInboxItems,
  type UnnamedInboxItem,
} from './inboxService';
import type { WorkspaceContext } from '../workspace/context';
import type { WorkspaceRegistry } from '../workspace/workspaceRegistry';

/** What the aggregate reads: the registry (every workspace), the warm contexts and the Studio-global alert store. */
export interface InboxAggregateDeps {
  registry: WorkspaceRegistry;
  /** The manager's live contexts; the launch context is always among them. */
  warm: () => WorkspaceContext[];
  alerts: AlertStore;
}

/** One workspace's disk-only contribution (cold path) or its service's non-alert items (warm path). */
async function workspaceItems(
  ctx: WorkspaceContext | undefined,
  repo: AgentRepo,
  workspaceId: string
): Promise<InboxItem[]> {
  if (ctx !== undefined) {
    // The service's list already carries this workspace's alerts; the
    // aggregate lists every undismissed alert once at the end instead.
    return (await ctx.inbox.list()).filter((item) => item.kind !== 'alert');
  }
  const [drafts, suggestions] = await Promise.all([
    draftInboxItems(repo, new DraftStore(repo), workspaceId),
    suggestionInboxItems(repo, new SuggestionStore(repo), workspaceId),
  ]);
  return [...drafts, ...suggestions];
}

/** The Studio-global alerts as unnamed rows, names resolved per owning workspace's repo. */
async function alertRows(
  alerts: AlertStore,
  repos: ReadonlyMap<string, AgentRepo>
): Promise<InboxItem[]> {
  const alertsList = await alerts.list();
  const unnamed: UnnamedInboxItem[] = alertsList.map((alert) => alertItem(alert.workspaceId, alert));
  const byWorkspace = new Map<string, UnnamedInboxItem[]>();
  for (const item of unnamed) {
    const rows = byWorkspace.get(item.workspaceId) ?? [];
    rows.push(item);
    byWorkspace.set(item.workspaceId, rows);
  }
  const named: InboxItem[] = [];
  for (const [workspaceId, rows] of byWorkspace) {
    const repo = repos.get(workspaceId);
    const names = repo === undefined ? new Map<string, string>() : await agentNamesOf(repo, rows);
    for (const item of rows) {
      named.push({ ...item, agentName: names.get(item.agentId) ?? item.agentId } as InboxItem);
    }
  }
  return named;
}

/** Every item's workspace merged and contract-sorted (W09a's `GET /inbox?ws=all`). */
export async function listAllInbox(deps: InboxAggregateDeps): Promise<WorkspaceInboxItem[]> {
  const refs = await deps.registry.list();
  const warm = new Map(deps.warm().map((ctx) => [ctx.ref.id, ctx]));
  const items: InboxItem[] = [];
  const repos = new Map<string, AgentRepo>();
  for (const ref of refs) {
    const ctx = warm.get(ref.id);
    try {
      // The repo feeds alert agent-name resolution even on the warm path.
      const repo = ctx?.repo ?? new AgentRepo(ref.root);
      repos.set(ref.id, repo);
      items.push(...(await workspaceItems(ctx, repo, ref.id)));
    } catch (error) {
      console.warn(`[agent-forge] skipping workspace '${ref.id}' in the aggregate inbox: ${(error as Error).message}`);
    }
  }
  items.push(...(await alertRows(deps.alerts, repos)));
  return items.sort(compareInboxItems) as WorkspaceInboxItem[];
}

/** The Studio-wide inbox total - what `WS /events?ws=all`'s `inbox.count` frame carries. */
export async function countAllInbox(deps: InboxAggregateDeps): Promise<number> {
  return (await listAllInbox(deps)).length;
}
