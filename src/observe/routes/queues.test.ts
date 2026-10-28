/**
 * Annotation queues API: create/list/get/delete queues, add trace ids, walk
 * them with `next`, and complete items into human score rows.
 */
import { describe, expect, it } from 'vitest';
import type * as http from 'node:http';
import type { IngestEvent } from '../envelope';
import { ingestBatch, openDb, pruneBefore, type ScoreRow } from '../store';
import type { ItemRow, QueueRow } from '../queues';
import type { SqlDatabase } from '../../storage/sqlite/driver';
// Through the registry, production's load order (see scores.test.ts).
import { matchRoute } from './index';

const T0 = 1_700_000_000_000;

interface Captured {
  status: number;
  body: unknown;
}

/** Calls the matched route with a recording ServerResponse stand-in. */
async function call(
  database: SqlDatabase,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown
): Promise<Captured> {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(chunk?: string) {
      captured.body = chunk === undefined || chunk === '' ? undefined : JSON.parse(chunk);
    },
  } as unknown as http.ServerResponse;
  const [pathname, search = ''] = path.split('?');
  const matched = matchRoute(method, pathname);
  if (!matched) throw new Error(`no route for ${method} ${pathname}`);
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  await matched.route.handle({
    db: database,
    dbPath: ':memory:',
    req: {} as http.IncomingMessage,
    res,
    params: matched.params,
    query: new URLSearchParams(search),
    readBody: () => Promise.resolve(text),
  });
  return captured;
}

const root = (traceId: string): IngestEvent =>
  ({
    type: 'observation',
    data: { obs_id: `${traceId}-root`, trace_id: traceId, agent_id: 'ag', kind: 'span', name: 'run', start: T0, end: T0 + 10 },
  }) as IngestEvent;

async function withDb(work: (database: SqlDatabase) => Promise<void>): Promise<void> {
  const database = openDb(':memory:');
  ingestBatch(database, [root('t1'), root('t2'), root('t3')]);
  try {
    await work(database);
  } finally {
    database.close();
  }
}

const invalid = { code: 'LOUSHO_REQUEST_INVALID' };
const queueOf = (c: Captured) => (c.body as { queue: QueueRow }).queue;
const itemOf = (c: Captured) => (c.body as { item: ItemRow }).item;

async function makeQueue(database: SqlDatabase, body: unknown = { name: 'review' }): Promise<QueueRow> {
  const created = await call(database, 'POST', '/api/v1/queues', body);
  expect(created.status).toBe(201);
  return queueOf(created);
}

const add = (database: SqlDatabase, id: string, trace_ids: string[]) =>
  call(database, 'POST', `/api/v1/queues/${id}/items`, { trace_ids });
const next = (database: SqlDatabase, id: string) => call(database, 'GET', `/api/v1/queues/${id}/next`);
const complete = (database: SqlDatabase, id: string, item: string, body: unknown) =>
  call(database, 'POST', `/api/v1/queues/${id}/items/${item}/complete`, body);
const humanScores = async (database: SqlDatabase, traceId: string) =>
  ((await call(database, 'GET', `/api/v1/scores?trace_id=${traceId}&source=human`)).body as { scores: ScoreRow[] }).scores;

describe('annotation queues API', () => {
  it('creates, lists, gets and deletes queues', async () => {
    await withDb(async (database) => {
      const first = await makeQueue(database, { name: 'a' });
      expect(first).toMatchObject({ name: 'a', rubric: [], counts: { pending: 0, done: 0, skipped: 0 } });
      expect(typeof first.queue_id).toBe('string');
      const second = await makeQueue(database, { name: 'b', rubric: [{ name: 'quality', min: 0, max: 5 }] });
      expect(second.rubric).toEqual([{ name: 'quality', min: 0, max: 5 }]);

      const list = (await call(database, 'GET', '/api/v1/queues')).body as { queues: QueueRow[]; total: number; limit: number; offset: number };
      expect(list.total).toBe(2);
      expect(list.limit).toBe(100);
      expect(list.offset).toBe(0);
      expect(list.queues.map((q) => q.name)).toEqual(['b', 'a']);

      const got = await call(database, 'GET', `/api/v1/queues/${first.queue_id}`);
      expect(got.status).toBe(200);
      expect(queueOf(got).name).toBe('a');

      await add(database, first.queue_id, ['t1']);
      const deleted = await call(database, 'DELETE', `/api/v1/queues/${first.queue_id}`);
      expect(deleted.status).toBe(204);
      expect((await call(database, 'GET', `/api/v1/queues/${first.queue_id}`)).status).toBe(404);
      expect((await call(database, 'DELETE', `/api/v1/queues/${first.queue_id}`)).status).toBe(404);
      const orphans = database.prepare('SELECT COUNT(*) AS n FROM annotation_items WHERE queue_id = ?').get(first.queue_id);
      expect(Number(orphans?.n)).toBe(0);
    });
  });

  it('409s a duplicate name and 400s bad bodies and rubrics', async () => {
    await withDb(async (database) => {
      await makeQueue(database, { name: 'a' });
      const dup = await call(database, 'POST', '/api/v1/queues', { name: 'a' });
      expect(dup.status).toBe(409);
      expect(dup.body).toMatchObject(invalid);
      const bad = [
        {},
        { name: '' },
        { name: 'x', extra: 1 },
        { name: 'x', rubric: [{ name: 'q', min: 5, max: 1 }] },
        { name: 'x', rubric: [{ name: 'q' }, { name: 'q' }] },
        { name: 'x', rubric: Array.from({ length: 51 }, (_, i) => ({ name: `r${i}` })) },
        { name: 'x', rubric: [{ name: 'q', extra: true }] },
      ];
      for (const body of bad) await expect(call(database, 'POST', '/api/v1/queues', body)).rejects.toMatchObject(invalid);
    });
  });

  it('adds trace ids in order, skips already-queued ones, and lists items oldest first', async () => {
    await withDb(async (database) => {
      const queue = await makeQueue(database);
      const first = await add(database, queue.queue_id, ['t2', 't1']);
      expect(first.status).toBe(201);
      const added = (first.body as { added: ItemRow[]; skipped_existing: string[] }).added;
      expect(added.map((i) => i.trace_id)).toEqual(['t2', 't1']);
      expect(added[0]).toMatchObject({ queue_id: queue.queue_id, status: 'pending', reviewer: null, done_at: null });

      const again = (await add(database, queue.queue_id, ['t1', 't3'])).body as { added: ItemRow[]; skipped_existing: string[] };
      expect(again.added.map((i) => i.trace_id)).toEqual(['t3']);
      expect(again.skipped_existing).toEqual(['t1']);

      const items = (await call(database, 'GET', `/api/v1/queues/${queue.queue_id}/items`)).body as { items: ItemRow[]; total: number };
      expect(items.total).toBe(3);
      expect(items.items.map((i) => i.trace_id)).toEqual(['t2', 't1', 't3']);
      expect(queueOf(await call(database, 'GET', `/api/v1/queues/${queue.queue_id}`)).counts).toEqual({ pending: 3, done: 0, skipped: 0 });
      await expect(call(database, 'GET', `/api/v1/queues/${queue.queue_id}/items?status=nope`)).rejects.toMatchObject(invalid);
    });
  });

  it('404s an unknown trace id and adds nothing', async () => {
    await withDb(async (database) => {
      const queue = await makeQueue(database);
      const out = await add(database, queue.queue_id, ['t1', 'ghost', 't2']);
      expect(out.status).toBe(404);
      expect(out.body).toMatchObject({ ...invalid, error: expect.stringContaining('ghost') });
      const items = (await call(database, 'GET', `/api/v1/queues/${queue.queue_id}/items`)).body as { total: number };
      expect(items.total).toBe(0);
      expect((await add(database, 'no-such-queue', ['t1'])).status).toBe(404);
      await expect(add(database, queue.queue_id, [])).rejects.toMatchObject(invalid);
    });
  });

  it('next returns the oldest pending item, 204 when none, 404 for an unknown queue', async () => {
    await withDb(async (database) => {
      const queue = await makeQueue(database);
      const empty = await next(database, queue.queue_id);
      expect(empty.status).toBe(204);
      expect(empty.body).toBeUndefined();
      expect((await next(database, 'nope')).status).toBe(404);

      await add(database, queue.queue_id, ['t3', 't1']);
      const got = await next(database, queue.queue_id);
      expect(got.status).toBe(200);
      expect(itemOf(got).trace_id).toBe('t3');
      // next does not claim: asking again returns the same item.
      expect(itemOf(await next(database, queue.queue_id)).item_id).toBe(itemOf(got).item_id);
    });
  });

  it('complete writes human scores, marks done, and next moves on', async () => {
    await withDb(async (database) => {
      const queue = await makeQueue(database);
      await add(database, queue.queue_id, ['t1', 't2']);
      const item = itemOf(await next(database, queue.queue_id));
      const done = await complete(database, queue.queue_id, item.item_id, {
        scores: [
          { name: 'quality', value: 4, comment: 'good' },
          { name: 'flagged', value: null },
        ],
        reviewer: 'ali',
      });
      expect(done.status).toBe(200);
      const body = done.body as { item: ItemRow; score_ids: string[] };
      expect(body.score_ids).toHaveLength(2);
      expect(body.item).toMatchObject({ status: 'done', reviewer: 'ali' });
      expect(typeof body.item.done_at).toBe('number');

      const scores = await humanScores(database, 't1');
      expect(scores.map((s) => s.name).sort()).toEqual(['flagged', 'quality']);
      expect(scores.find((s) => s.name === 'quality')).toMatchObject({ value: 4, comment: 'good', source: 'human', agent_id: 'ag' });

      expect(itemOf(await next(database, queue.queue_id)).trace_id).toBe('t2');
      expect(queueOf(await call(database, 'GET', `/api/v1/queues/${queue.queue_id}`)).counts).toEqual({ pending: 1, done: 1, skipped: 0 });

      const twice = await complete(database, queue.queue_id, item.item_id, { scores: [{ name: 'quality', value: 1 }] });
      expect(twice.status).toBe(409);
      expect(await humanScores(database, 't1')).toHaveLength(2);
    });
  });

  it('skips an item, and 400s a skip carrying scores', async () => {
    await withDb(async (database) => {
      const queue = await makeQueue(database);
      await add(database, queue.queue_id, ['t1', 't2']);
      const item = itemOf(await next(database, queue.queue_id));
      await expect(
        complete(database, queue.queue_id, item.item_id, { status: 'skipped', scores: [{ name: 'q', value: 1 }] })
      ).rejects.toMatchObject(invalid);
      const skipped = await complete(database, queue.queue_id, item.item_id, { status: 'skipped', scores: [] });
      expect(skipped.status).toBe(200);
      expect(itemOf(skipped).status).toBe('skipped');
      expect(itemOf(await next(database, queue.queue_id)).trace_id).toBe('t2');
      expect((await complete(database, queue.queue_id, 'nope', { scores: [] })).status).toBe(404);
    });
  });

  it('checks scores against a non-empty rubric', async () => {
    await withDb(async (database) => {
      const queue = await makeQueue(database, { name: 'r', rubric: [{ name: 'quality', min: 0, max: 5 }, { name: 'tone' }] });
      await add(database, queue.queue_id, ['t1']);
      const item = itemOf(await next(database, queue.queue_id));
      await expect(complete(database, queue.queue_id, item.item_id, { scores: [{ name: 'other', value: 1 }] })).rejects.toMatchObject(invalid);
      await expect(complete(database, queue.queue_id, item.item_id, { scores: [{ name: 'quality', value: 9 }] })).rejects.toMatchObject(invalid);
      expect(await humanScores(database, 't1')).toHaveLength(0);
      const ok = await complete(database, queue.queue_id, item.item_id, {
        scores: [
          { name: 'quality', value: 5 },
          { name: 'tone', value: -3 },
        ],
      });
      expect(ok.status).toBe(200);
    });
  });

  it('keeps items of a pruned trace; completing one 404s and leaves it pending', async () => {
    await withDb(async (database) => {
      const queue = await makeQueue(database);
      await add(database, queue.queue_id, ['t1']);
      pruneBefore(database, T0 + 1_000_000);
      const item = itemOf(await next(database, queue.queue_id));
      expect(item.trace_id).toBe('t1');
      const out = await complete(database, queue.queue_id, item.item_id, { scores: [{ name: 'q', value: 1 }] });
      expect(out.status).toBe(404);
      expect(out.body).toMatchObject({ ...invalid, error: expect.stringContaining('t1') });
      expect(itemOf(await next(database, queue.queue_id)).status).toBe('pending');
    });
  });
});
