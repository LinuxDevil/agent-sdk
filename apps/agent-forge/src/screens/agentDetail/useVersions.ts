import { useCallback } from 'react';

import { runtimeClient } from '../../runtime/runtimeClient';
import { useFetchedResource } from '../../state/useFetchedResource';
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
 * `agent.changed` with a version-writing reason re-fetches. The
 * fetch/guard skeleton is `useFetchedResource`.
 */
export function useVersions(agentId: string): {
  items: VersionListItem[] | undefined;
  error: string | undefined;
  loading: boolean;
  refresh(): Promise<void>;
  patchSummary(version: number, summary: string): void;
} {
  const { value: items, error, loading, refresh, setValue: setItems } = useFetchedResource<VersionListItem[]>({
    key: agentId,
    fetch: (id) => runtimeClient.listVersions(id),
  });

  const patchSummary = useCallback((version: number, summary: string) => {
    setItems((prev) =>
      prev === undefined ? prev : prev.map((item) => (item.version === version ? { ...item, summary } : item)),
    );
  }, [setItems]);

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
