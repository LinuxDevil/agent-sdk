/**
 * Annotation queues (LangSmith "annotation queues"): named lists of traces a
 * human walks through, scoring each one. Completing an item writes its scores
 * as human score rows, the same rows `POST /api/v1/scores` writes.
 *
 * - `GET /api/v1/queues?limit&offset` -> `{ queues, total, limit, offset }`, newest first.
 * - `POST /api/v1/queues` `{ name, rubric? }` -> `201 { queue }` (a taken name is a 409).
 * - `GET /api/v1/queues/:id` -> `{ queue }`; `DELETE` -> `204`.
 * - `GET /api/v1/queues/:id/items?status&limit&offset` -> `{ items, total, limit, offset }`, oldest first.
 * - `POST /api/v1/queues/:id/items` `{ trace_ids }` -> `201 { added, skipped_existing }`.
 * - `GET /api/v1/queues/:id/next` -> `{ item }`, the oldest pending; `204` when none.
 *   It does not claim the item: this is a single-reviewer local tool.
 * - `POST /api/v1/queues/:id/items/:item/complete` `{ scores, reviewer?, status? }`
 *   -> `{ item, score_ids }`.
 *
 * Auth is the daemon's global API-token check; nothing per-route.
 */

import type * as http from 'node:http';
import { z } from 'zod';

import { SDKError } from '../../execution/errors';
import { ScoreTargetMissingError } from '../humanScores';
import {
  addItems,
  completeItem,
  createQueue,
  deleteQueue,
  getItem,
  getQueue,
  ITEM_STATUSES,
  listItems,
  listQueues,
  nextItem,
  type ItemStatus,
  type QueueRow,
} from '../queues';
import { intParam, requireJsonBody, sendJson, type Route } from './httpKit';

const QUEUE_BODY_LIMIT = 256 * 1024;

const rubricEntry = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .strict()
  .refine((entry) => entry.min === undefined || entry.max === undefined || entry.min <= entry.max, {
    message: 'min must not exceed max',
  });

const rubricSchema = z
  .array(rubricEntry)
  .max(50)
  .refine((entries) => new Set(entries.map((e) => e.name)).size === entries.length, { message: 'rubric names must be unique' });

const createBody = z.object({ name: z.string().trim().min(1).max(200), rubric: rubricSchema.default([]) }).strict();

const addBody = z.object({ trace_ids: z.array(z.string().min(1)).min(1).max(500) }).strict();

const completeBody = z
  .object({
    scores: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(200),
            value: z.number().finite().nullable(),
            comment: z.string().max(10_000).optional(),
          })
          .strict()
      )
      .max(50),
    reviewer: z.string().max(200).optional(),
    status: z.enum(['done', 'skipped']).default('done'),
  })
  .strict();

const invalid = (message: string): SDKError => new SDKError(message, 'LOUSHO_REQUEST_INVALID', { appendHelp: false });

const answer = (res: http.ServerResponse, status: number, error: string): void =>
  sendJson(res, status, { error, code: 'LOUSHO_REQUEST_INVALID' });

const queueMissing = (res: http.ServerResponse, id: string): void => answer(res, 404, `No annotation queue '${id}'.`);

/** The list's `status` filter; a bad value throws `LOUSHO_REQUEST_INVALID`. */
function statusFilter(query: URLSearchParams): ItemStatus | undefined {
  const status = query.get('status');
  if (status === null) return undefined;
  if (!(ITEM_STATUSES as readonly string[]).includes(status)) {
    throw invalid(`Invalid queue items query: status must be one of ${ITEM_STATUSES.map((s) => `'${s}'`).join(', ')}.`);
  }
  return status as ItemStatus;
}

/** A complete body checked against the queue: no scores on a skip, and rubric names/bounds when it has one. */
function checkOutcome(queue: QueueRow, body: z.infer<typeof completeBody>): void {
  if (body.status === 'skipped' && body.scores.length > 0) throw invalid('Invalid complete body: a skipped item takes no scores.');
  if (queue.rubric.length === 0) return;
  for (const score of body.scores) {
    const entry = queue.rubric.find((r) => r.name === score.name);
    if (entry === undefined) {
      throw invalid(`Invalid complete body: score '${score.name}' is not in the queue's rubric (${queue.rubric.map((r) => r.name).join(', ')}).`);
    }
    const value = score.value;
    if (value === null) continue;
    if ((entry.min !== undefined && value < entry.min) || (entry.max !== undefined && value > entry.max)) {
      throw invalid(`Invalid complete body: score '${score.name}' value ${value} is outside [${entry.min ?? '-inf'}, ${entry.max ?? 'inf'}].`);
    }
  }
}

/** Pagination shared by both list routes. */
function page(query: URLSearchParams): { limit: number; offset: number } {
  return {
    limit: intParam(query, 'limit', 100, { min: 1, max: 1000 }),
    offset: intParam(query, 'offset', 0, { min: 0, max: Number.MAX_SAFE_INTEGER }),
  };
}

export const queuesRoutes: readonly Route[] = [
  {
    method: 'GET',
    path: '/api/v1/queues',
    handle: ({ db, res, query }) => {
      const paging = page(query);
      sendJson(res, 200, { ...listQueues(db, paging), ...paging });
    },
  },
  {
    method: 'POST',
    path: '/api/v1/queues',
    handle: async ({ db, res, readBody }) => {
      const body = requireJsonBody(createBody, await readBody(QUEUE_BODY_LIMIT), 'annotation queue');
      const queue = createQueue(db, body);
      if (queue === undefined) return answer(res, 409, `An annotation queue named '${body.name}' already exists.`);
      sendJson(res, 201, { queue });
    },
  },
  {
    method: 'GET',
    path: '/api/v1/queues/:id',
    handle: ({ db, res, params }) => {
      const queue = getQueue(db, params.id);
      if (queue === undefined) return queueMissing(res, params.id);
      sendJson(res, 200, { queue });
    },
  },
  {
    method: 'DELETE',
    path: '/api/v1/queues/:id',
    handle: ({ db, res, params }) => {
      if (!deleteQueue(db, params.id)) return queueMissing(res, params.id);
      res.writeHead(204);
      res.end();
    },
  },
  {
    method: 'GET',
    path: '/api/v1/queues/:id/items',
    handle: ({ db, res, params, query }) => {
      const status = statusFilter(query);
      if (getQueue(db, params.id) === undefined) return queueMissing(res, params.id);
      const paging = page(query);
      sendJson(res, 200, { ...listItems(db, params.id, { ...paging, status }), ...paging });
    },
  },
  {
    method: 'POST',
    path: '/api/v1/queues/:id/items',
    handle: async ({ db, res, params, readBody }) => {
      const body = requireJsonBody(addBody, await readBody(QUEUE_BODY_LIMIT), 'queue items');
      if (getQueue(db, params.id) === undefined) return queueMissing(res, params.id);
      const result = addItems(db, params.id, body.trace_ids);
      if ('unknown' in result) return answer(res, 404, `No trace '${result.unknown}'; nothing was added.`);
      sendJson(res, 201, result);
    },
  },
  {
    method: 'GET',
    path: '/api/v1/queues/:id/next',
    handle: ({ db, res, params }) => {
      if (getQueue(db, params.id) === undefined) return queueMissing(res, params.id);
      const item = nextItem(db, params.id);
      if (item === undefined) {
        res.writeHead(204);
        res.end();
        return;
      }
      sendJson(res, 200, { item });
    },
  },
  {
    method: 'POST',
    path: '/api/v1/queues/:id/items/:item/complete',
    handle: async ({ db, res, params, readBody }) => {
      const body = requireJsonBody(completeBody, await readBody(QUEUE_BODY_LIMIT), 'complete');
      const queue = getQueue(db, params.id);
      if (queue === undefined) return queueMissing(res, params.id);
      const item = getItem(db, params.id, params.item);
      if (item === undefined) return answer(res, 404, `No item '${params.item}' in annotation queue '${params.id}'.`);
      checkOutcome(queue, body);
      let result: ReturnType<typeof completeItem>;
      try {
        result = completeItem(db, item, body);
      } catch (error) {
        if (error instanceof ScoreTargetMissingError) return answer(res, 404, `${error.message} It may have been pruned.`);
        throw error;
      }
      if (result === 'finished') return answer(res, 409, `Item '${item.item_id}' is already ${item.status === 'pending' ? 'finished' : item.status}.`);
      sendJson(res, 200, result);
    },
  },
];
