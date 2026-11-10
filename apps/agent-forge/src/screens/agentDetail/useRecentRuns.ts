import { useCallback, useEffect, useState } from 'react';

import type { TraceSummaryPayload } from '../../../shared/wireTypes';
import { runtimeClient } from '../../runtime/runtimeClient';

/** What {@link useRecentRuns} reports for the Overview card's run list. */
export interface RecentRunsState {
  /** The newest runs (`runtimeClient.listTraces(agentId, 5)`); `undefined` while loading or after an error. */
  runs: TraceSummaryPayload[] | undefined;
  /** The fetch's error message, when it failed. */
  error: string | undefined;
  /** Re-runs the fetch (the error state's Retry). */
  refresh(): void;
}

/**
 * Loads the agent's five newest persisted traces for the Overview tab's
 * Recent runs card, refetching when `agentId` changes. These are the
 * Studio's local trace files, so the card works without the observe daemon.
 */
export function useRecentRuns(agentId: string): RecentRunsState {
  const [runs, setRuns] = useState<TraceSummaryPayload[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRuns(undefined);
    setError(undefined);
    runtimeClient
      .listTraces(agentId, 5)
      .then((next) => {
        if (cancelled) return;
        setRuns(next);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { runs, error, refresh };
}
