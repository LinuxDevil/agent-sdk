/**
 * The `#/agents` list's data (A02, scoped per W06b): `GET /agents?ws=all`
 * in all-workspaces mode, `forWorkspace(id).listAgents()` mapped to
 * `WorkspaceAgentItem` in one-workspace mode. The card switch's
 * optimistic `PATCH /agents/:id/meta` goes through
 * `forWorkspace(item.workspaceId)` - ids repeat across workspaces, so
 * `pendingIds` keys are `<workspaceId>/<agentId>` and `setEnabled` takes
 * the whole item.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentListItem, AllAgentsResponse, WorkspaceAgentItem } from '../../../shared/wireTypes';
import { runtimeClient } from '../../runtime/runtimeClient';
import { useToast } from '../../ui/Toast';

/** Which agents the list shows: every workspace's, or one workspace's. */
export type AgentListScope = { kind: 'all' } | { kind: 'workspace'; workspaceId: string };

/** What the list screen renders from. */
export interface AgentListState {
  items: WorkspaceAgentItem[] | undefined;
  /** Workspaces the aggregate could not read (all mode only; empty otherwise). */
  skipped: AllAgentsResponse['skipped'];
  error: string | undefined;
  loading: boolean;
  refresh(): void;
  setEnabled(item: WorkspaceAgentItem, enabled: boolean): Promise<void>;
  /** `<workspaceId>/<agentId>` keys with a `PATCH /meta` in flight - their card switch stays disabled. */
  pendingIds: ReadonlySet<string>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The `<workspaceId>/<agentId>` pending key - agent ids repeat across workspaces. */
export function pendingKey(item: { workspaceId: string; id: string }): string {
  return `${item.workspaceId}/${item.id}`;
}

/** One workspace's `AgentListItem[]` as `WorkspaceAgentItem[]` (W06b's workspace-mode mapping). */
function toWorkspaceItems(workspaceId: string, items: AgentListItem[]): WorkspaceAgentItem[] {
  return items.map((item) => ({ ...item, kind: 'workspace' as const, workspaceId }));
}

/** Fetches the agent list for `scope` and owns the optimistic enable/disable toggle. */
export function useAgentList(scope: AgentListScope): AgentListState {
  const toast = useToast();
  const [items, setItems] = useState<WorkspaceAgentItem[] | undefined>(undefined);
  const [skipped, setSkipped] = useState<AllAgentsResponse['skipped']>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  // Guards against an out-of-order response winning (refresh racing the mount fetch, or a scope change).
  const requestSeq = useRef(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      if (scope.kind === 'all') {
        const res = await runtimeClient.listAllAgentItems();
        if (seq !== requestSeq.current) return;
        // W07a adds observed items to the union; the card grid is
        // workspace-only until W07b renders observed cards.
        setItems(res.items.filter((item): item is WorkspaceAgentItem => item.kind === 'workspace'));
        setSkipped(res.skipped);
      } else {
        const list = await runtimeClient.forWorkspace(scope.workspaceId).listAgents();
        if (seq !== requestSeq.current) return;
        setItems(toWorkspaceItems(scope.workspaceId, list));
        setSkipped([]);
      }
      setError(undefined);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(messageOf(err));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  const setEnabled = useCallback(
    async (item: WorkspaceAgentItem, enabled: boolean) => {
      const key = pendingKey(item);
      const target = itemsRef.current?.find((i) => pendingKey(i) === key);
      const name = target?.name ?? item.id;
      const was = target?.enabled;
      setItems((prev) => prev?.map((i) => (pendingKey(i) === key ? { ...i, enabled } : i)));
      setPendingIds((prev) => new Set(prev).add(key));
      try {
        await runtimeClient.forWorkspace(item.workspaceId).patchAgentMeta(item.id, { enabled });
        toast.show({ message: `“${name}” is ${enabled ? 'on' : 'off'}`, tone: 'success' });
      } catch (err) {
        if (was !== undefined) {
          setItems((prev) => prev?.map((i) => (pendingKey(i) === key ? { ...i, enabled: was } : i)));
        }
        toast.show({ message: messageOf(err), tone: 'error' });
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [toast]
  );

  return { items, skipped, error, loading, refresh, setEnabled, pendingIds };
}
