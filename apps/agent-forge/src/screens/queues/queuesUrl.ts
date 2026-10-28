/**
 * The Annotation queues screen's URL state.
 *
 * - `#/evals/queues[?offset=]` - the queue list; `offset` pages server-side
 *   and the default `0` is never written.
 * - `#/evals/queues/:id` - the review view for one queue (`:id` is the
 *   URL-encoded `queue_id`). The trace step selected there stays local state.
 */

/** Queues per list page, requested from the daemon (`limit`). */
export const QUEUES_PAGE_SIZE = 50;

/** The hash path of the queue list at `offset`. */
export const queuesPath = (offset?: number): string => (offset ? `/evals/queues?offset=${offset}` : '/evals/queues');

/** The hash path of one queue's review view. */
export const queuePath = (queueId: string): string => `/evals/queues/${encodeURIComponent(queueId)}`;
