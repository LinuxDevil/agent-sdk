/**
 * The `#/agents` list's data (A02): `GET /agents` on mount and on `refresh`,
 * and the card switch's optimistic `PATCH /agents/:id/meta` with toast
 * feedback. Kept out of the v1 `useAppState().agents` list - that is the
 * builder's rail, not the card grid's source.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentListItem } from '../../../shared/wireTypes';
import { runtimeClient } from '../../runtime/runtimeClient';
import { useToast } from '../../ui/Toast';

/** What the list screen renders from: the items (undefined until the first load lands), the error, and the toggle plumbing. */
export interface AgentListState {
  items: AgentListItem[] | undefined;
  error: string | undefined;
  loading: boolean;
  refresh(): void;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  /** Ids with a `PATCH /meta` in flight - their card switch stays disabled. */
  pendingIds: ReadonlySet<string>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Fetches the agent list and owns the optimistic enable/disable toggle. */
export function useAgentList(): AgentListState {
  const toast = useToast();
  const [items, setItems] = useState<AgentListItem[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  // Guards against an out-of-order response winning (refresh racing the mount fetch).
  const requestSeq = useRef(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const list = await runtimeClient.listAgents();
      if (seq !== requestSeq.current) return;
      setItems(list);
      setError(undefined);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(messageOf(err));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  const setEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      const target = itemsRef.current?.find((item) => item.id === id);
      const name = target?.name ?? id;
      const was = target?.enabled;
      setItems((prev) => prev?.map((item) => (item.id === id ? { ...item, enabled } : item)));
      setPendingIds((prev) => new Set(prev).add(id));
      try {
        await runtimeClient.patchAgentMeta(id, { enabled });
        toast.show({ message: `“${name}” is ${enabled ? 'on' : 'off'}`, tone: 'success' });
      } catch (err) {
        if (was !== undefined) {
          setItems((prev) => prev?.map((item) => (item.id === id ? { ...item, enabled: was } : item)));
        }
        toast.show({ message: messageOf(err), tone: 'error' });
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [toast]
  );

  return { items, error, loading, refresh, setEnabled, pendingIds };
}
