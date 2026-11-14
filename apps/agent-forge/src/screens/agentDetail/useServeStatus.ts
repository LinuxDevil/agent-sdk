import { useCallback, type Dispatch, type SetStateAction } from 'react';

import { runtimeClient } from '../../runtime/runtimeClient';
import { useFetchedResource } from '../../state/useFetchedResource';
import { useStudioEvents } from '../../state/useStudioEvents';
import type { ServeStatus, StudioEvent } from '../../../shared/wireTypes';

/** `agent.changed` reasons that can move the publish pointer the serve status reports. */
const SERVE_REASONS = new Set<Extract<StudioEvent, { type: 'agent.changed' }>['reason']>(['version', 'meta']);

/**
 * The Serve card's data (X02b): `GET /agents/:id/serve` on mount and
 * whenever `agentId` changes, refreshed live by the shared `/events`
 * socket - an `agent.changed` with a `version` or `meta` reason for this
 * agent re-fetches (a publish or a meta edit moves `publishedVersion`).
 * The fetch/guard skeleton is `useFetchedResource`.
 */
export function useServeStatus(agentId: string): {
  status: ServeStatus | undefined;
  loading: boolean;
  error: string | undefined;
  refresh(): Promise<void>;
  setStatus: Dispatch<SetStateAction<ServeStatus | undefined>>;
} {
  const { value: status, error, loading, refresh, setValue: setStatus } = useFetchedResource<ServeStatus>({
    key: agentId,
    fetch: (id) => runtimeClient.getServe(id),
  });

  const onEvent = useCallback(
    (event: StudioEvent) => {
      if (event.type === 'agent.changed' && event.agentId === agentId && SERVE_REASONS.has(event.reason)) {
        void refresh();
      }
    },
    [agentId, refresh],
  );
  useStudioEvents(onEvent);

  return { status, loading, error, refresh, setStatus };
}
