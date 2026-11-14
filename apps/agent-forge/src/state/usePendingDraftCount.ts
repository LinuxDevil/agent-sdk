import { runtimeClient } from '../runtime/runtimeClient';
import { useDraftRefreshEvents } from './useDraftRefreshEvents';
import { useFetchedResource } from './useFetchedResource';

/**
 * The Suggestions tab badge (L11b): `1` while the agent has a pending
 * `ChangeDraft`, `0` otherwise - `undefined` `agentId` (an unsaved
 * agent) reads as `0` without a request. Refreshed by the shared
 * `/events` socket on `draft.changed` and on spec-moving `agent.changed`
 * reasons; the fetch/guard skeleton is `useFetchedResource`, and a
 * failed read counts as no draft (the badge errs toward quiet).
 */
export function usePendingDraftCount(agentId: string | undefined): number {
  const { value, refresh } = useFetchedResource<number>({
    key: agentId,
    // The count has no error surface: a failed read shows as 0 like the
    // original catch-all did, so swallow it inside the fetcher.
    fetch: async (id) => {
      try {
        return (await runtimeClient.getDraft(id)) === undefined ? 0 : 1;
      } catch {
        return 0;
      }
    },
  });
  useDraftRefreshEvents(agentId, refresh);
  return value ?? 0;
}
