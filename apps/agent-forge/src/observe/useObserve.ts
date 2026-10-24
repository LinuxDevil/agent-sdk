/**
 * React hooks over {@link ObserveClient}. `useObserveQuery` is the shared
 * fetch/cancel/refresh plumbing; the per-endpoint hooks below map 1:1 onto
 * the daemon's read routes. Every hook re-fetches when its `refreshKey`
 * argument changes, so panels can wire a Refresh button (or a poll) without
 * duplicating effect logic.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { observeClient, ObserveDaemonDownError, type InsightsFilter, type ScoreListFilter, type TraceListFilter } from './observeClient';
import type {
  ObserveAgentRow,
  ObserveHealth,
  ObserveInsights,
  ObserveScorePassRate,
  ObserveScoreRow,
  ObserveTraceDetail,
  ObserveTraceList,
} from './types';

export interface ObserveQuery<T> {
  data: T | undefined;
  /** The fetch failure, if any - `ObserveDaemonDownError` means "run `lousho observe start`". */
  error: Error | undefined;
  /** True while the first fetch is in flight (refreshes keep the old data and don't flag it). */
  loading: boolean;
  /** Re-runs the fetch. */
  refresh: () => void;
}

function useObserveQuery<T>(fetcher: () => Promise<T>, deps: readonly unknown[]): ObserveQuery<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  // The latest fetcher's identity isn't a dep - callers pass `deps` for that;
  // keeping it in a ref avoids an unstable-inline-callback refetch loop.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetcherRef
      .current()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(undefined);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setData(undefined);
        setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Callers own `deps` (fetcher identity is a ref, not a dep).
  }, [...deps, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, refresh };
}

/** `GET /health`, re-probed on `pollMs` (default 5s) so the panels wake up once `lousho observe start` runs. */
export function useDaemonHealth(pollMs = 5000): ObserveQuery<ObserveHealth | undefined> & { down: boolean } {
  const query = useObserveQuery<ObserveHealth | undefined>(() => observeClient.health(), []);
  // `down` is the last *settled* probe's verdict: a re-probe in flight flips
  // `loading` back on, and must not briefly read as "up" (that remounted the
  // panels and fired their fetches against a dead daemon every poll).
  const settledDown = query.error instanceof ObserveDaemonDownError || query.data === undefined;
  const [down, setDown] = useState(false);
  useEffect(() => {
    if (!query.loading) setDown(settledDown);
  }, [query.loading, settledDown]);
  useEffect(() => {
    if (pollMs <= 0) return undefined;
    const timer = setInterval(query.refresh, pollMs);
    return () => clearInterval(timer);
    // `query.refresh` is a stable useCallback; re-arming only on pollMs.
  }, [pollMs, query.refresh]);
  return { ...query, down };
}

export function useTraces(filter: TraceListFilter, refreshKey?: unknown): ObserveQuery<ObserveTraceList> {
  const query = useObserveQuery(() => observeClient.listTraces(filter), [JSON.stringify(filter), refreshKey]);
  return query;
}

export function useTraceDetail(traceId: string | undefined, refreshKey?: unknown): ObserveQuery<ObserveTraceDetail | undefined> {
  return useObserveQuery(
    () => (traceId === undefined ? Promise.resolve(undefined) : observeClient.traceDetail(traceId)),
    [traceId, refreshKey]
  );
}

export function useAgents(project?: string, refreshKey?: unknown): ObserveQuery<ObserveAgentRow[]> {
  return useObserveQuery(() => observeClient.listAgents(project), [project, refreshKey]);
}

export function useInsights(filter: InsightsFilter, refreshKey?: unknown): ObserveQuery<ObserveInsights> {
  return useObserveQuery(() => observeClient.insights(filter), [JSON.stringify(filter), refreshKey]);
}

export function useScores(filter: ScoreListFilter, refreshKey?: unknown): ObserveQuery<ObserveScoreRow[]> {
  return useObserveQuery(() => observeClient.listScores(filter), [JSON.stringify(filter), refreshKey]);
}

/**
 * One eval's score rows (`eval=<name>` plus `filter`); no request while
 * `evalName` is empty. `data` is only ever rows of the current `evalName`:
 * after a switch it stays undefined (loading) until the new eval's rows land.
 */
export function useEvalScores(
  evalName: string,
  filter: Omit<ScoreListFilter, 'eval'>,
  refreshKey?: unknown
): ObserveQuery<ObserveScoreRow[] | undefined> {
  const query = useObserveQuery(
    async () => (evalName ? { evalName, rows: await observeClient.listScores({ ...filter, eval: evalName }) } : undefined),
    [evalName, JSON.stringify(filter), refreshKey]
  );
  return { ...query, data: query.data?.evalName === evalName ? query.data.rows : undefined };
}

export function useScorePassRates(
  filter: Omit<ScoreListFilter, 'limit'>,
  refreshKey?: unknown
): ObserveQuery<ObserveScorePassRate[]> {
  return useObserveQuery(() => observeClient.scorePassRates(filter), [JSON.stringify(filter), refreshKey]);
}

/**
 * The observe screens' shared "daemon down" verdict: the health probe says so,
 * or one of `queries` failed to reach it. While down, every query re-runs each
 * `pollMs`, so the screen recovers in place (URL untouched) once the daemon is
 * back even if the health probe never saw it go.
 */
export function useDaemonDown(
  healthDown: boolean,
  queries: readonly Pick<ObserveQuery<unknown>, 'error' | 'refresh'>[],
  pollMs = 5000
): boolean {
  const down = healthDown || queries.some((q) => q.error instanceof ObserveDaemonDownError);
  const latest = useRef(queries);
  latest.current = queries;
  useEffect(() => {
    if (!down || pollMs <= 0) return undefined;
    const timer = setInterval(() => {
      for (const q of latest.current) q.refresh();
    }, pollMs);
    return () => clearInterval(timer);
  }, [down, pollMs]);
  return down;
}
