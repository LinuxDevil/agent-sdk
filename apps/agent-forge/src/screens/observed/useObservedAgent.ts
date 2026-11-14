/**
 * `useObservedAgent` (W07b): everything `#/observed/:agentId` renders, read
 * from the observe daemon through {@link ObserveClient}. The route id is the
 * newest instance's daemon `agent_id` (an `ObservedAgentItem.id`); the page
 * then lists EVERY daemon row sharing that row's project+name (the group's
 * instances, newest first), merges the instances' recent traces and scores
 * (newest first, capped at 20), and takes the eval pass rates from the
 * newest instance.
 *
 * `notFound` is the daemon answering `listAgents()` with no row whose
 * `agent_id` is the route id - distinct from a fetch failure (`error`).
 */
import { observeClient } from '../../observe/observeClient';
import { useObserveQuery } from '../../observe/useObserve';
import type { ObserveAgentRow, ObserveScorePassRate, ObserveScoreRow, ObserveTraceRow } from '../../observe/types';

/** The observed page's data: instances plus the merged recent activity. */
export interface ObservedAgentData {
  /** Every daemon row with the same project and name, newest first. */
  instances: ObserveAgentRow[];
  /** Up to 20 traces merged across up to 10 instances, newest first. */
  traces: ObserveTraceRow[];
  /** Up to 20 human/judge/eval scores merged across the instances, newest first. */
  scores: ObserveScoreRow[];
  /** Eval pass rates from the newest instance. */
  passRates: ObserveScorePassRate[];
}

/** How many instances feed the merged trace/score lists. */
const MAX_FETCHED_INSTANCES = 10;
/** Rows kept per merged list. */
const MERGED_LIMIT = 20;
/** Rows asked of the daemon per instance before merging. */
const PER_INSTANCE_LIMIT = 20;

/** Newest first by heartbeat (falling back to first sighting). */
function byRecency(a: ObserveAgentRow, b: ObserveAgentRow): number {
  return (b.last_heartbeat ?? b.first_seen) - (a.last_heartbeat ?? a.first_seen);
}

interface ObservedAgentResult {
  data?: ObservedAgentData;
  notFound?: boolean;
}

async function fetchObservedAgent(agentId: string): Promise<ObservedAgentResult> {
  const registry = await observeClient.listAgents();
  const row = registry.find((r) => r.agent_id === agentId);
  if (row === undefined) return { notFound: true };
  // Instances = every row with the same project AND name; a null project
  // can't be filtered server-side, so `listAgents(undefined)` then a
  // client-side match on both fields.
  const peers = (await observeClient.listAgents(row.project ?? undefined))
    .filter((r) => r.name === row.name && (r.project ?? null) === (row.project ?? null))
    .sort(byRecency);
  const ids = peers.slice(0, MAX_FETCHED_INSTANCES).map((r) => r.agent_id);
  const [tracePages, scorePages, passRates] = await Promise.all([
    Promise.all(ids.map((id) => observeClient.listTraces({ agent_id: id, limit: PER_INSTANCE_LIMIT }).then((l) => l.traces))),
    Promise.all(ids.map((id) => observeClient.listScores({ agent_id: id, limit: PER_INSTANCE_LIMIT }))),
    observeClient.scorePassRates({ agent_id: peers[0].agent_id }),
  ]);
  const traces = tracePages
    .flat()
    .sort((a, b) => b.start - a.start)
    .slice(0, MERGED_LIMIT);
  const scores = scorePages
    .flat()
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, MERGED_LIMIT);
  return { data: { instances: peers, traces, scores, passRates } };
}

/**
 * The observed page's query. Returns `data` (undefined until the first
 * answer), `loading`, `error` (the fetch failure's message), `notFound`
 * (the daemon has no such agent) and `refresh` for the error state's Retry.
 */
export function useObservedAgent(agentId: string): {
  data: ObservedAgentData | undefined;
  loading: boolean;
  error: string | undefined;
  notFound: boolean;
  refresh(): void;
} {
  const query = useObserveQuery(() => fetchObservedAgent(agentId), [agentId]);
  return {
    data: query.data?.data,
    loading: query.loading,
    error: query.error?.message,
    notFound: query.data?.notFound === true,
    refresh: query.refresh,
  };
}
