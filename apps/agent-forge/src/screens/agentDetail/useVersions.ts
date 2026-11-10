import { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage } from '../../components/errorMessage';
import { runtimeClient } from '../../runtime/runtimeClient';
import { useStudioEvents } from '../../state/useStudioEvents';
import type { StudioEvent, VersionListItem } from '../../../shared/wireTypes';

/** `agent.changed` reasons that mean the version list itself moved. */
const VERSION_REASONS = new Set<Extract<StudioEvent, { type: 'agent.changed' }>['reason']>([
  'version',
  'restore',
  'import',
  'save',
]);

/**
 * The Versions tab's data (L01): `GET /agents/:id/versions` on mount and
 * whenever `agentId` changes, refreshed live by the shared `/events`
 * socket - `version.summary` fills a pending summary in place, an
 * `agent.changed` with a version-writing reason re-fetches. A request
 * counter drops stale responses so a slow earlier fetch cannot overwrite
 * a newer one.
 */
export function useVersions(agentId: string): {
  items: VersionListItem[] | undefined;
  error: string | undefined;
  loading: boolean;
  refresh(): Promise<void>;
  patchSummary(version: number, summary: string): void;
} {
  const [items, setItems] = useState<VersionListItem[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const list = await runtimeClient.listVersions(agentId);
      if (request !== requestRef.current) return;
      setItems(list);
      setError(undefined);
    } catch (err) {
      if (request !== requestRef.current) return;
      setError(errorMessage(err));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const patchSummary = useCallback((version: number, summary: string) => {
    setItems((prev) =>
      prev === undefined ? prev : prev.map((item) => (item.version === version ? { ...item, summary } : item)),
    );
  }, []);

  useStudioEvents(
    useCallback(
      (event: StudioEvent) => {
        if (event.type !== 'version.summary' && event.type !== 'agent.changed') return;
        if (event.agentId !== agentId) return;
        if (event.type === 'version.summary') {
          patchSummary(event.version, event.summary);
        } else if (event.type === 'agent.changed' && VERSION_REASONS.has(event.reason)) {
          void refresh();
        }
      },
      [agentId, patchSummary, refresh],
    ),
  );

  return { items, error, loading, refresh, patchSummary };
}
