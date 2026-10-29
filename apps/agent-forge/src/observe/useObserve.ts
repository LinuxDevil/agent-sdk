/**
 * React hooks over {@link ObserveClient}. `useObserveQuery` is the shared
 * fetch/cancel/refresh plumbing; the per-endpoint hooks below map 1:1 onto
 * the daemon's read routes. Every hook re-fetches when its `refreshKey`
 * argument changes, so panels can wire a Refresh button (or a poll) without
 * duplicating effect logic.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { observeClient, ObserveDaemonDownError, type EvaluatorListFilter, type HubEntryFilter, type InsightsFilter, type PageQuery, type ScoreListFilter, type SessionListFilter, type TraceListFilter } from './observeClient';
import type {
  ObserveAgentRow,
  ObserveDatasetDetail,
  ObserveDatasetList,
  ObserveEvaluator,
  ObserveEvaluatorList,
  ObserveQueue,
  ObserveQueueItem,
  ObserveQueueList,
  ObserveHealth,
  ObserveHubEntry,
  ObserveInsights,
  ObservePromptHistory,
  ObservePromptRow,
  ObserveScorePassRate,
  ObserveScoreRow,
  ObserveSessionDetail,
  ObserveSessionList,
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

export function useSessions(filter: SessionListFilter, refreshKey?: unknown): ObserveQuery<ObserveSessionList> {
  return useObserveQuery(() => observeClient.listSessions(filter), [JSON.stringify(filter), refreshKey]);
}

export function useSession(sessionId: string, refreshKey?: unknown): ObserveQuery<ObserveSessionDetail | undefined> {
  return useObserveQuery(() => observeClient.session(sessionId), [sessionId, refreshKey]);
}

export function useAgents(project?: string, refreshKey?: unknown): ObserveQuery<ObserveAgentRow[]> {
  return useObserveQuery(() => observeClient.listAgents(project), [project, refreshKey]);
}

export function useInsights(filter: InsightsFilter, refreshKey?: unknown): ObserveQuery<ObserveInsights> {
  return useObserveQuery(() => observeClient.insights(filter), [JSON.stringify(filter), refreshKey]);
}

/**
 * {@link useInsights} whose `data` is only ever the answer fetched for the
 * current `tag`: after the tag changes (e.g. a new window or granularity) it
 * stays undefined (loading) until that tag's answer lands, so nothing draws
 * stale rows against the new buckets. Polls under the same tag keep the last answer.
 */
export function useTaggedInsights(
  tag: string,
  filter: InsightsFilter,
  refreshKey?: unknown
): ObserveQuery<ObserveInsights> {
  const query = useObserveQuery(
    async () => ({ tag, insights: await observeClient.insights(filter) }),
    [tag, JSON.stringify(filter), refreshKey]
  );
  return { ...query, data: query.data?.tag === tag ? query.data.insights : undefined };
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

export function usePrompts(refreshKey?: unknown): ObserveQuery<ObservePromptRow[]> {
  return useObserveQuery(() => observeClient.listPrompts(), [refreshKey]);
}

export function usePromptVersions(name: string, refreshKey?: unknown): ObserveQuery<ObservePromptHistory | undefined> {
  return useObserveQuery(() => observeClient.promptVersions(name), [name, refreshKey]);
}

/** `GET /api/v1/hub`; `filter` undefined (no viewer agent yet) skips the request and resolves to `[]`. */
export function useHubEntries(filter: HubEntryFilter | undefined, refreshKey?: unknown): ObserveQuery<ObserveHubEntry[]> {
  return useObserveQuery(
    () => (filter === undefined ? Promise.resolve([]) : observeClient.listHubEntries(filter)),
    [JSON.stringify(filter), refreshKey]
  );
}

/** `GET /api/v1/datasets` - one page of datasets. */
export function useDatasets(page: PageQuery, refreshKey?: unknown): ObserveQuery<ObserveDatasetList> {
  return useObserveQuery(() => observeClient.listDatasets(page), [JSON.stringify(page), refreshKey]);
}

/** `GET /api/v1/datasets/:name` - the dataset and one page of its examples; `undefined` data when it does not exist. */
export function useDataset(name: string, page: PageQuery, refreshKey?: unknown): ObserveQuery<ObserveDatasetDetail | undefined> {
  return useObserveQuery(() => observeClient.dataset(name, page), [name, JSON.stringify(page), refreshKey]);
}

/** `GET /api/v1/queues` - one page of annotation queues. */
export function useQueues(page: PageQuery, refreshKey?: unknown): ObserveQuery<ObserveQueueList> {
  return useObserveQuery(() => observeClient.listQueues(page), [JSON.stringify(page), refreshKey]);
}

/** `GET /api/v1/queues/:id` - one annotation queue; `undefined` data when it does not exist. */
export function useQueue(queueId: string, refreshKey?: unknown): ObserveQuery<ObserveQueue | undefined> {
  return useObserveQuery(() => observeClient.queue(queueId), [queueId, refreshKey]);
}

/** `GET /api/v1/queues/:id/next` - the queue's next pending item; `undefined` data when the queue is empty. */
export function useNextQueueItem(queueId: string, refreshKey?: unknown): ObserveQuery<ObserveQueueItem | undefined> {
  return useObserveQuery(() => observeClient.nextQueueItem(queueId), [queueId, refreshKey]);
}

/** `GET /api/v1/evaluators` - a page of online evaluator rules. */
export function useEvaluators(filter: EvaluatorListFilter, refreshKey?: unknown): ObserveQuery<ObserveEvaluatorList> {
  return useObserveQuery(() => observeClient.listEvaluators(filter), [JSON.stringify(filter), refreshKey]);
}

/** `GET /api/v1/evaluators/:id` - one rule; `data` is `undefined` for an unknown id. */
export function useEvaluator(ruleId: string, refreshKey?: unknown): ObserveQuery<ObserveEvaluator | undefined> {
  return useObserveQuery(() => observeClient.evaluator(ruleId), [ruleId, refreshKey]);
}

/** The newest `limit` online-evaluator scores (`GET /api/v1/scores?source=online`), newest first. */
export function useOnlineScores(limit: number, refreshKey?: unknown): ObserveQuery<ObserveScoreRow[]> {
  return useObserveQuery(() => observeClient.listScores({ source: 'online', limit }), [limit, refreshKey]);
}
