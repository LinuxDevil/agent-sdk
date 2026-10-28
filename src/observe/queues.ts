/**
 * Annotation queues data access: named lists of traces for a human to
 * review, each with an optional rubric. Completing an item writes its scores
 * as human score rows (the same rows `POST /api/v1/scores` writes). Kept out
 * of store.ts so retention (`pruneBefore`) never learns about them; an item's
 * `trace_id` may outlive its trace.
 */

import { randomUUID } from 'node:crypto';

import type { SqlDatabase } from '../storage/sqlite/driver';
import { writeHumanScore, type HumanScoreInput } from './humanScores';
import { transaction } from './store';

/** One rubric entry: a score name the queue expects, optionally bounded. */
export interface RubricEntry {
  name: string;
  description?: string;
  min?: number;
  max?: number;
}

/** Where an item stands. */
export type ItemStatus = 'pending' | 'done' | 'skipped';

/** The item statuses, in display order. */
export const ITEM_STATUSES: readonly ItemStatus[] = ['pending', 'done', 'skipped'];

/** One queue, with how many items it holds per status. */
export interface QueueRow {
  queue_id: string;
  name: string;
  rubric: RubricEntry[];
  created_at: number;
  counts: Record<ItemStatus, number>;
}

/** One queued trace. */
export interface ItemRow {
  item_id: string;
  queue_id: string;
  trace_id: string;
  status: ItemStatus;
  reviewer: string | null;
  created_at: number;
  done_at: number | null;
}

const QUEUE_SELECT = `
  SELECT q.queue_id, q.name, q.rubric, q.created_at,
    (SELECT COUNT(*) FROM annotation_items i WHERE i.queue_id = q.queue_id AND i.status = 'pending') AS pending,
    (SELECT COUNT(*) FROM annotation_items i WHERE i.queue_id = q.queue_id AND i.status = 'done') AS done,
    (SELECT COUNT(*) FROM annotation_items i WHERE i.queue_id = q.queue_id AND i.status = 'skipped') AS skipped
  FROM annotation_queues q`;

function toQueue(row: Record<string, unknown>): QueueRow {
  return {
    queue_id: String(row.queue_id),
    name: String(row.name),
    rubric: JSON.parse(String(row.rubric)) as RubricEntry[],
    created_at: Number(row.created_at),
    counts: { pending: Number(row.pending), done: Number(row.done), skipped: Number(row.skipped) },
  };
}

function toItem(row: Record<string, unknown>): ItemRow {
  return {
    item_id: String(row.item_id),
    queue_id: String(row.queue_id),
    trace_id: String(row.trace_id),
    status: String(row.status) as ItemStatus,
    reviewer: row.reviewer === null ? null : String(row.reviewer),
    created_at: Number(row.created_at),
    done_at: row.done_at === null ? null : Number(row.done_at),
  };
}

/** The queue `queueId`, or `undefined`. */
export function getQueue(db: SqlDatabase, queueId: string): QueueRow | undefined {
  const row = db.prepare(`${QUEUE_SELECT} WHERE q.queue_id = ?`).get(queueId);
  return row === undefined ? undefined : toQueue(row);
}

/** Create a queue; `undefined` when the name is taken. */
export function createQueue(
  db: SqlDatabase,
  fields: { name: string; rubric: RubricEntry[] },
  now: number = Date.now()
): QueueRow | undefined {
  if (db.prepare('SELECT 1 AS ok FROM annotation_queues WHERE name = ?').get(fields.name) !== undefined) return undefined;
  const queueId = randomUUID();
  db.prepare('INSERT INTO annotation_queues (queue_id, name, rubric, created_at) VALUES (?, ?, ?, ?)').run(
    queueId,
    fields.name,
    JSON.stringify(fields.rubric),
    now
  );
  return getQueue(db, queueId);
}

/** Delete a queue and its items; `false` when it is unknown. */
export function deleteQueue(db: SqlDatabase, queueId: string): boolean {
  return transaction(db, () => {
    db.prepare('DELETE FROM annotation_items WHERE queue_id = ?').run(queueId);
    return Number(db.prepare('DELETE FROM annotation_queues WHERE queue_id = ?').run(queueId).changes) > 0;
  });
}

/** A page of queues, newest first, plus the total. */
export function listQueues(db: SqlDatabase, options: { limit: number; offset: number }): { queues: QueueRow[]; total: number } {
  const rows = db.prepare(`${QUEUE_SELECT} ORDER BY q.created_at DESC, q.rowid DESC LIMIT ? OFFSET ?`).all(options.limit, options.offset);
  const total = db.prepare('SELECT COUNT(*) AS n FROM annotation_queues').get();
  return { queues: rows.map(toQueue), total: Number(total?.n ?? 0) };
}

/** A page of a queue's items, oldest first (insertion order breaks ties), plus the total matching. */
export function listItems(
  db: SqlDatabase,
  queueId: string,
  options: { limit: number; offset: number; status?: ItemStatus }
): { items: ItemRow[]; total: number } {
  const clause = options.status === undefined ? '' : ' AND status = ?';
  const args: string[] = options.status === undefined ? [queueId] : [queueId, options.status];
  const rows = db
    .prepare(`SELECT * FROM annotation_items WHERE queue_id = ?${clause} ORDER BY created_at ASC, rowid ASC LIMIT ? OFFSET ?`)
    .all(...args, options.limit, options.offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM annotation_items WHERE queue_id = ?${clause}`).get(...args);
  return { items: rows.map(toItem), total: Number(total?.n ?? 0) };
}

/**
 * Queue `traceIds` in the order given, in one transaction. Every id must
 * name a stored trace, else nothing is added and the first unknown id comes
 * back as `{ unknown }`. Ids already in the queue (or repeated in the call)
 * are skipped, not errors.
 */
export function addItems(
  db: SqlDatabase,
  queueId: string,
  traceIds: readonly string[],
  now: number = Date.now()
): { added: ItemRow[]; skipped_existing: string[] } | { unknown: string } {
  return transaction(db, () => {
    const traceExists = db.prepare('SELECT 1 AS ok FROM observations WHERE trace_id = ? LIMIT 1');
    const unknown = traceIds.find((traceId) => traceExists.get(traceId) === undefined);
    if (unknown !== undefined) return { unknown };
    const queued = db.prepare('SELECT 1 AS ok FROM annotation_items WHERE queue_id = ? AND trace_id = ?');
    const insert = db.prepare(
      "INSERT INTO annotation_items (item_id, queue_id, trace_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
    );
    const addedIds: string[] = [];
    const skipped_existing: string[] = [];
    for (const traceId of traceIds) {
      if (queued.get(queueId, traceId) !== undefined) {
        skipped_existing.push(traceId);
        continue;
      }
      const itemId = randomUUID();
      insert.run(itemId, queueId, traceId, now);
      addedIds.push(itemId);
    }
    const byId = db.prepare('SELECT * FROM annotation_items WHERE item_id = ?');
    return { added: addedIds.map((id) => toItem(byId.get(id) as Record<string, unknown>)), skipped_existing };
  });
}

/** The queue's oldest pending item, or `undefined`. Does not claim it. */
export function nextItem(db: SqlDatabase, queueId: string): ItemRow | undefined {
  const row = db
    .prepare("SELECT * FROM annotation_items WHERE queue_id = ? AND status = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT 1")
    .get(queueId);
  return row === undefined ? undefined : toItem(row);
}

/** The item `itemId` of queue `queueId`, or `undefined`. */
export function getItem(db: SqlDatabase, queueId: string, itemId: string): ItemRow | undefined {
  const row = db.prepare('SELECT * FROM annotation_items WHERE item_id = ? AND queue_id = ?').get(itemId, queueId);
  return row === undefined ? undefined : toItem(row);
}

/**
 * Finish a pending item: write each score as a human score on its trace and
 * set `status`, `reviewer` and `done_at`, all in one transaction. `'finished'`
 * when the item is already done or skipped. A pruned trace throws
 * `ScoreTargetMissingError` (from the score write) and the item stays pending.
 */
export function completeItem(
  db: SqlDatabase,
  item: ItemRow,
  outcome: { scores: Omit<HumanScoreInput, 'trace_id' | 'obs_id'>[]; reviewer?: string; status: 'done' | 'skipped' },
  now: number = Date.now()
): { item: ItemRow; score_ids: string[] } | 'finished' {
  return transaction(db, () => {
    const current = getItem(db, item.queue_id, item.item_id);
    if (current === undefined || current.status !== 'pending') return 'finished';
    const score_ids = outcome.scores.map((score) => writeHumanScore(db, { ...score, trace_id: item.trace_id }, now));
    db.prepare('UPDATE annotation_items SET status = ?, reviewer = ?, done_at = ? WHERE item_id = ?').run(
      outcome.status,
      outcome.reviewer ?? null,
      now,
      item.item_id
    );
    return { item: getItem(db, item.queue_id, item.item_id) as ItemRow, score_ids };
  });
}
