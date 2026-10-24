/**
 * Datasets API: create/list/get datasets, add examples (literal or copied
 * from a trace's root observation), delete examples, and retention leaving
 * datasets alone.
 */
import { describe, expect, it } from 'vitest';
import type * as http from 'node:http';
import type { IngestEvent } from '../envelope';
import { ingestBatch, openDb, pruneBefore } from '../store';
import type { DatasetRow, ExampleRow } from '../datasets';
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
  method: 'GET' | 'POST' | 'DELETE',
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

const obs = (over: Record<string, unknown>): IngestEvent =>
  ({ type: 'observation', data: { trace_id: 'tr', kind: 'span', name: 'run', start: T0, end: T0 + 10, ...over } }) as IngestEvent;

function seeded(): SqlDatabase {
  const database = openDb(':memory:');
  ingestBatch(database, [
    obs({ obs_id: 'root', input: '{"question":"refund?"}', output: 'Refund issued.' }),
    obs({ obs_id: 'child', parent_obs_id: 'root', kind: 'generation', input: 'child in', output: 'child out' }),
    obs({ obs_id: 'bare', trace_id: 'no-input' }),
  ]);
  return database;
}

async function withDb(work: (database: SqlDatabase) => Promise<void>): Promise<void> {
  const database = seeded();
  try {
    await work(database);
  } finally {
    database.close();
  }
}

const create = (database: SqlDatabase, body: unknown) => call(database, 'POST', '/api/v1/datasets', body);
const addExample = (database: SqlDatabase, name: string, body: unknown) =>
  call(database, 'POST', `/api/v1/datasets/${name}/examples`, body);

describe('POST /api/v1/datasets', () => {
  it('201s with the dataset row; a duplicate name is 409; a bad name is a 400', async () => {
    await withDb(async (database) => {
      const out = await create(database, { name: 'refunds', description: 'refund cases' });
      expect(out.status).toBe(201);
      const { dataset } = out.body as { dataset: DatasetRow };
      expect(dataset).toMatchObject({ name: 'refunds', description: 'refund cases', example_count: 0 });
      expect(dataset.dataset_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof dataset.created_at).toBe('number');

      const dup = await create(database, { name: 'refunds' });
      expect(dup.status).toBe(409);
      expect(dup.body).toMatchObject({ code: 'LOUSHO_REQUEST_INVALID' });

      for (const name of ['', '-lead', 'has space', 'a/b', 'x'.repeat(201)]) {
        await expect(create(database, { name })).rejects.toMatchObject({ code: 'LOUSHO_REQUEST_INVALID' });
      }
      const plain = (await create(database, { name: 'v1.2_ok-x' })).body as { dataset: DatasetRow };
      expect(plain.dataset.description).toBeNull();
    });
  });
});

describe('GET /api/v1/datasets', () => {
  it('lists newest first with total and paging', async () => {
    await withDb(async (database) => {
      for (const name of ['a', 'b', 'c']) await create(database, { name });
      const all = (await call(database, 'GET', '/api/v1/datasets')).body as {
        datasets: DatasetRow[];
        total: number;
        limit: number;
        offset: number;
      };
      expect(all.total).toBe(3);
      expect(all.limit).toBe(100);
      expect(all.offset).toBe(0);
      expect(all.datasets).toHaveLength(3);
      const page = (await call(database, 'GET', '/api/v1/datasets?limit=1&offset=1')).body as { datasets: DatasetRow[]; total: number };
      expect(page.total).toBe(3);
      expect(page.datasets).toHaveLength(1);
      expect(page.datasets[0].name).toBe(all.datasets[1].name);
    });
  });
});

describe('POST /api/v1/datasets/:name/examples', () => {
  it('adds a literal { input, expected } example', async () => {
    await withDb(async (database) => {
      await create(database, { name: 'ds' });
      const out = await addExample(database, 'ds', { input: { q: 'hi' }, expected: 'hello' });
      expect(out.status).toBe(201);
      const { example } = out.body as { example: ExampleRow };
      expect(example).toMatchObject({ input: { q: 'hi' }, expected: 'hello', source_trace_id: null });
      const noExpected = (await addExample(database, 'ds', { input: 0 })).body as { example: ExampleRow };
      expect(noExpected.example).toMatchObject({ input: 0, expected: null });
    });
  });

  it('copies the trace root input and output from from_trace_id', async () => {
    await withDb(async (database) => {
      await create(database, { name: 'ds' });
      const out = await addExample(database, 'ds', { from_trace_id: 'tr' });
      expect(out.status).toBe(201);
      const { example } = out.body as { example: ExampleRow };
      // JSON text parses back to its value; plain text stays a string.
      expect(example).toMatchObject({ input: { question: 'refund?' }, expected: 'Refund issued.', source_trace_id: 'tr' });
    });
  });

  it('404s an unknown trace or dataset; 400s a root without captured input', async () => {
    await withDb(async (database) => {
      await create(database, { name: 'ds' });
      expect((await addExample(database, 'ds', { from_trace_id: 'nope' })).status).toBe(404);
      expect((await addExample(database, 'missing', { input: 1 })).status).toBe(404);
      const bare = await addExample(database, 'ds', { from_trace_id: 'no-input' });
      expect(bare.status).toBe(400);
      expect((bare.body as { error: string }).error).toMatch(/no captured input/);
    });
  });

  it('rejects both or neither of input/from_trace_id with 400', async () => {
    await withDb(async (database) => {
      await create(database, { name: 'ds' });
      for (const body of [{}, { expected: 1 }, { input: 1, from_trace_id: 'tr' }]) {
        await expect(addExample(database, 'ds', body)).rejects.toMatchObject({ code: 'LOUSHO_REQUEST_INVALID' });
      }
    });
  });
});

describe('GET /api/v1/datasets/:name and DELETE examples', () => {
  it('returns examples oldest first; delete is 204 then 404', async () => {
    await withDb(async (database) => {
      await create(database, { name: 'ds' });
      await create(database, { name: 'other' });
      const ids: string[] = [];
      for (const input of ['one', 'two', 'three']) {
        ids.push(((await addExample(database, 'ds', { input })).body as { example: ExampleRow }).example.example_id);
      }
      const got = (await call(database, 'GET', '/api/v1/datasets/ds')).body as {
        dataset: DatasetRow;
        examples: ExampleRow[];
        total: number;
        limit: number;
      };
      expect(got.dataset.example_count).toBe(3);
      expect(got.total).toBe(3);
      expect(got.limit).toBe(1000);
      expect(got.examples.map((e) => e.input)).toEqual(['one', 'two', 'three']);
      expect((await call(database, 'GET', '/api/v1/datasets/nope')).status).toBe(404);

      const del = await call(database, 'DELETE', `/api/v1/datasets/ds/examples/${ids[1]}`);
      expect(del).toEqual({ status: 204, body: undefined });
      expect((await call(database, 'DELETE', `/api/v1/datasets/ds/examples/${ids[1]}`)).status).toBe(404);
      expect((await call(database, 'DELETE', `/api/v1/datasets/other/examples/${ids[0]}`)).status).toBe(404);
      expect((await call(database, 'DELETE', `/api/v1/datasets/nope/examples/${ids[0]}`)).status).toBe(404);
      const after = (await call(database, 'GET', '/api/v1/datasets/ds')).body as { examples: ExampleRow[] };
      expect(after.examples.map((e) => e.input)).toEqual(['one', 'three']);
    });
  });

  it('survives retention pruning of its source trace', async () => {
    await withDb(async (database) => {
      await create(database, { name: 'ds' });
      await addExample(database, 'ds', { from_trace_id: 'tr' });
      pruneBefore(database, T0 + 1_000_000);
      const got = (await call(database, 'GET', '/api/v1/datasets/ds')).body as { examples: ExampleRow[] };
      expect(got.examples).toHaveLength(1);
      expect(got.examples[0].source_trace_id).toBe('tr');
    });
  });
});
