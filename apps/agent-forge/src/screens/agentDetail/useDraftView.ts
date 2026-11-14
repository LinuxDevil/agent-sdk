import { runtimeClient } from '../../runtime/runtimeClient';
import { useDraftRefreshEvents } from '../../state/useDraftRefreshEvents';
import { useFetchedResource } from '../../state/useFetchedResource';
import type { DraftView } from '../../../shared/wireTypes';

/**
 * The Suggestions tab's draft (L11b): `GET /agents/:id/draft` on mount and
 * whenever `agentId` changes, refreshed live by the shared `/events`
 * socket - every `draft.changed` for the agent (create, restate, the
 * review pass's write-backs, approve/reject/withdraw) and an
 * `agent.changed` with a spec-moving reason re-fetches the `DraftView`.
 * The fetch/guard skeleton is `useFetchedResource`.
 */
export function useDraftView(agentId: string): {
  draft: DraftView | undefined;
  error: string | undefined;
  loading: boolean;
  refresh(): Promise<void>;
} {
  const { value, error, loading, refresh } = useFetchedResource<DraftView | undefined>({
    key: agentId,
    fetch: (id) => runtimeClient.getDraft(id),
  });
  useDraftRefreshEvents(agentId, refresh);
  return { draft: value, error, loading, refresh };
}
