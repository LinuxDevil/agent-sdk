import type { TraceSummaryPayload } from '../../../../shared/wireTypes';
import type { ObserveScoreRow } from '../../../observe/types';

/** A Runs-tab row: the trace summary plus its latest human `rating` score, when the daemon reported one. */
export interface RunRow extends TraceSummaryPayload {
  rating: number | null;
  ratingComment: string | null;
}

/**
 * Joins runs with their latest `rating` score on `trace_id` (the newest
 * `created_at` wins per trace). Runs keep their order - the trace list
 * arrives newest first and stays that way.
 */
export function joinRatings(runs: TraceSummaryPayload[], scores: ObserveScoreRow[]): RunRow[] {
  const latest = new Map<string, ObserveScoreRow>();
  for (const score of scores) {
    if (score.name !== 'rating') continue;
    const prev = latest.get(score.trace_id);
    if (prev === undefined || score.created_at > prev.created_at) latest.set(score.trace_id, score);
  }
  return runs.map((run) => {
    const score = latest.get(run.traceId);
    return { ...run, rating: score?.value ?? null, ratingComment: score?.comment ?? null };
  });
}
