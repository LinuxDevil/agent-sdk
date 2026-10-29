/**
 * The Annotation queues screen's URL state.
 *
 * - `#/evals/queues[?offset=]` - the queue list; `offset` pages server-side
 *   and the default `0` is never written.
 * - `#/evals/queues/:id` - the review view for one queue (`:id` is the
 *   URL-encoded `queue_id`). The trace step selected there stays local state.
 */
import type { ObserveRubricEntry } from '../../observe/types';

/** Queues per list page, requested from the daemon (`limit`). */
export const QUEUES_PAGE_SIZE = 50;

/** The hash path of the queue list at `offset`. */
export const queuesPath = (offset?: number): string => (offset ? `/evals/queues?offset=${offset}` : '/evals/queues');

/** The hash path of one queue's review view. */
export const queuePath = (queueId: string): string => `/evals/queues/${encodeURIComponent(queueId)}`;

/** A rubric entry's bounds in a few characters: `0–5`, `≥ 1`, `≤ 10`, or `any` when unbounded. */
export function rubricRange(entry: ObserveRubricEntry): string {
  if (entry.min !== undefined && entry.max !== undefined) return `${entry.min}–${entry.max}`;
  if (entry.min !== undefined) return `≥ ${entry.min}`;
  if (entry.max !== undefined) return `≤ ${entry.max}`;
  return 'any';
}
