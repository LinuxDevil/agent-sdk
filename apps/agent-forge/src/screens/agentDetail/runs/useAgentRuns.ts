import { useCallback, useEffect, useState } from 'react';

import type { TraceSummaryPayload } from '../../../../shared/wireTypes';
import { observeClient } from '../../../observe/observeClient';
import type { ObserveScoreRow } from '../../../observe/types';
import { runtimeClient } from '../../../runtime/runtimeClient';
import { joinRatings, type RunRow } from './runsModel';

/** What {@link useAgentRuns} reports for the Runs tab. */
export interface AgentRunsState {
  /** The agent's runs with their ratings joined on; `undefined` until the first fetch settles. */
  rows: RunRow[] | undefined;
  /** True while a fetch is in flight. */
  loading: boolean;
  /** The run list's error message, when it failed (the ratings fetch never blocks the runs). */
  error: string | undefined;
  /** True when `listScores` failed (daemon down or any error): ratings render as "—". */
  ratingsUnavailable: boolean;
  /** Re-runs both fetches (the toolbar's Refresh and the error state's Retry). */
  refresh(): void;
}

/**
 * Loads the agent's runs (`runtimeClient.listTraces(agentId, 100)` - the
 * Studio's local trace files, so they work without the observe daemon) and
 * the daemon's human `rating` scores in parallel via `Promise.allSettled`,
 * joined client-side on `trace_id` by {@link joinRatings}. Refetches when
 * `agentId` changes or {@link AgentRunsState.refresh} is called.
 */
export function useAgentRuns(agentId: string): AgentRunsState {
  const [runs, setRuns] = useState<TraceSummaryPayload[] | undefined>(undefined);
  const [scores, setScores] = useState<ObserveScoreRow[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [ratingsUnavailable, setRatingsUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRuns(undefined);
    setScores(undefined);
    setError(undefined);
    setRatingsUnavailable(false);
    setLoading(true);
    Promise.allSettled([
      runtimeClient.listTraces(agentId, 100),
      observeClient.listScores({ name: 'rating', source: 'human', limit: 1000 }),
    ]).then(([runsResult, scoresResult]) => {
      if (cancelled) return;
      setLoading(false);
      if (runsResult.status === 'rejected') {
        setError(runsResult.reason instanceof Error ? runsResult.reason.message : String(runsResult.reason));
        return;
      }
      setRuns(runsResult.value);
      if (scoresResult.status === 'fulfilled') {
        setScores(scoresResult.value);
      } else {
        setScores([]);
        setRatingsUnavailable(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [agentId, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const rows = runs === undefined ? undefined : joinRatings(runs, scores ?? []);
  return { rows, loading, error, ratingsUnavailable, refresh };
}
