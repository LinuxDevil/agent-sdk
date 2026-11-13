/**
 * The `#/agents` list's data (A02, scoped per W06b, observed per W07b):
 * `GET /agents?ws=all` in all-workspaces mode, `forWorkspace(id).listAgents()`
 * mapped to `WorkspaceAgentItem` in one-workspace mode - plus, in both
 * modes, the aggregate route's observed items (workspace mode keeps only
 * the ones placed in that workspace). The card switch's optimistic
 * `PATCH /agents/:id/meta` goes through `forWorkspace(item.workspaceId)` -
 * ids repeat across workspaces, so `pendingIds` keys are
 * `<workspaceId>/<agentId>` and `setEnabled` takes the whole item.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentListItem, AllAgentsResponse, AnyAgentItem, CodeAgentDir, CodeAgentItem, WorkspaceAgentItem } from '../../../shared/wireTypes';
import { runtimeClient } from '../../runtime/runtimeClient';
import { useToast } from '../../ui/Toast';

/** Which agents the list shows: every workspace's, or one workspace's. */
export type AgentListScope = { kind: 'all' } | { kind: 'workspace'; workspaceId: string };

/** What the list screen renders from. */
export interface AgentListState {
  /** Workspace AND observed items (`AnyAgentItem`); the screen narrows by `kind`. */
  items: AnyAgentItem[] | undefined;
  /** Workspaces the aggregate could not read (all mode only; empty otherwise). */
  skipped: AllAgentsResponse['skipped'];
  /** Whether the collector answered ('ok') or not ('unavailable', W07a). */
  observed: AllAgentsResponse['observed'];
  error: string | undefined;
  loading: boolean;
  refresh(): void;
  setEnabled(item: WorkspaceAgentItem, enabled: boolean): Promise<void>;
  /** `<workspaceId>/<agentId>` keys with a `PATCH /meta` in flight - their card switch stays disabled. */
  pendingIds: ReadonlySet<string>;
  /** Workspace mode only: true while a `Rescan code` POST is in flight. */
  scanningCode: boolean;
  /**
   * Workspace mode only (W08b): `POST /workspaces/:ws/scan`, then the
   * result's dirs replace this workspace's code items in `items` (same
   * dedupe as the load). `workspaceName` is the display name for the
   * success toast. No-op in all-workspaces mode.
   */
  rescanCode(workspaceName: string): Promise<void>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The `<workspaceId>/<agentId>` pending key - agent ids repeat across workspaces. */
export function pendingKey(item: { workspaceId: string | null; id: string }): string {
  return `${item.workspaceId}/${item.id}`;
}

/** One workspace's `AgentListItem[]` as `WorkspaceAgentItem[]` (W06b's workspace-mode mapping). */
function toWorkspaceItems(workspaceId: string, items: AgentListItem[]): WorkspaceAgentItem[] {
  return items.map((item) => ({ ...item, kind: 'workspace' as const, workspaceId }));
}

/** The observed items the aggregate placed in `workspaceId` (workspace mode's share of W07b). */
function observedInWorkspace(items: AnyAgentItem[], workspaceId: string): AnyAgentItem[] {
  return items.filter((item) => item.kind === 'observed' && item.workspaceId === workspaceId);
}

/**
 * Scan dirs as `CodeAgentItem`s (W08b): `id` is the dir's workspace-relative
 * path (the `#/w/<ws>/code-agents/<path>` key), and a dir whose `name`
 * equals a Studio agent id is omitted - the Studio copy wins (W08a's rule).
 */
function toCodeAgentItems(workspaceId: string, dirs: CodeAgentDir[], agentIds: ReadonlySet<string>): CodeAgentItem[] {
  return dirs
    .filter((dir) => !agentIds.has(dir.name))
    .map((dir) => ({
      kind: 'code' as const,
      id: dir.path,
      name: dir.name,
      workspaceId,
      configFile: dir.configFile,
      configKind: dir.configKind,
    }));
}

/** Fetches the agent list for `scope` and owns the optimistic enable/disable toggle. */
export function useAgentList(scope: AgentListScope): AgentListState {
  const toast = useToast();
  const [items, setItems] = useState<AnyAgentItem[] | undefined>(undefined);
  const [skipped, setSkipped] = useState<AllAgentsResponse['skipped']>([]);
  const [observed, setObserved] = useState<AllAgentsResponse['observed']>('ok');
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [scanningCode, setScanningCode] = useState(false);
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
        setItems(res.items);
        setSkipped(res.skipped);
        setObserved(res.observed ?? 'ok');
      } else {
        // The workspace's own list is the required read; the aggregate and
        // the code-agent scan (W08b) are best-effort - the aggregate only
        // contributes its observed items placed in THIS workspace, and a
        // failed read must not take the list down with it.
        const [list, aggregate, scan] = await Promise.all([
          runtimeClient.forWorkspace(scope.workspaceId).listAgents(),
          runtimeClient.listAllAgentItems().catch(() => undefined),
          runtimeClient.workspaceScan(scope.workspaceId).catch(() => undefined),
        ]);
        if (seq !== requestSeq.current) return;
        setItems([
          ...toWorkspaceItems(scope.workspaceId, list),
          ...(aggregate === undefined ? [] : observedInWorkspace(aggregate.items, scope.workspaceId)),
          ...toCodeAgentItems(scope.workspaceId, scan?.agents ?? [], new Set(list.map((item) => item.id))),
        ]);
        setSkipped([]);
        setObserved(aggregate?.observed ?? 'ok');
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

  const rescanCode = useCallback(
    async (workspaceName: string) => {
      if (scope.kind !== 'workspace') return;
      setScanningCode(true);
      try {
        const result = await runtimeClient.scanWorkspace(scope.workspaceId);
        const agentIds = new Set(
          (itemsRef.current ?? [])
            .filter((item): item is WorkspaceAgentItem => item.kind === 'workspace' && item.workspaceId === scope.workspaceId)
            .map((item) => item.id)
        );
        const codeItems = toCodeAgentItems(scope.workspaceId, result.agents, agentIds);
        setItems((prev) => [...(prev ?? []).filter((item) => item.kind !== 'code'), ...codeItems]);
        const n = codeItems.length;
        toast.show({
          message: `Found ${n} code agent${n === 1 ? '' : 's'} in ${workspaceName}.`,
          tone: 'success',
        });
      } catch (err) {
        toast.show({ message: messageOf(err), tone: 'error' });
      } finally {
        setScanningCode(false);
      }
    },
    [scope, toast]
  );

  const setEnabled = useCallback(
    async (item: WorkspaceAgentItem, enabled: boolean) => {
      const key = pendingKey(item);
      const target = itemsRef.current?.find((i): i is WorkspaceAgentItem => i.kind === 'workspace' && pendingKey(i) === key);
      const name = target?.name ?? item.id;
      const was = target?.enabled;
      setItems((prev) => prev?.map((i) => (i.kind === 'workspace' && pendingKey(i) === key ? { ...i, enabled } : i)));
      setPendingIds((prev) => new Set(prev).add(key));
      try {
        await runtimeClient.forWorkspace(item.workspaceId).patchAgentMeta(item.id, { enabled });
        toast.show({ message: `“${name}” is ${enabled ? 'on' : 'off'}`, tone: 'success' });
      } catch (err) {
        if (was !== undefined) {
          setItems((prev) => prev?.map((i) => (i.kind === 'workspace' && pendingKey(i) === key ? { ...i, enabled: was } : i)));
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

  return { items, skipped, observed, error, loading, refresh, setEnabled, pendingIds, scanningCode, rescanCode };
}
