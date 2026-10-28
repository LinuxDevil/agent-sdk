/**
 * defineEval({ dataset: 'name' }): the cases come from the observe daemon's
 * dataset registry (`GET /api/v1/datasets/:name`), fetched at collection.
 * A stub daemon (node:http on 127.0.0.1:0) stands in for `lousho observe`.
 */
import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { SDKError } from '../execution/errors';
import { equals } from './checks';
import { defineEval } from './defineEval';
import { fetchDatasetCases, type DatasetCase } from './dataset';
import { TAGS_ENV } from './recorder';

const EXAMPLES = [
  { example_id: 'ex_1', dataset_id: 'ds_1', input: 'refund order 42', expected: 'echo refund order 42', source_trace_id: 'tr_9', created_at: 1 },
  { example_id: 'ex_2', dataset_id: 'ds_1', input: 'refund order 7', expected: 'echo refund order 7', source_trace_id: null, created_at: 2 },
];

const requests: Array<{ url: string; auth?: string }> = [];

/** Serves `refunds` one example per page (so paging is exercised), `blank` with none, `broken` without `examples`, `html` not JSON. */
const server = http.createServer((req, res) => {
  requests.push({ url: req.url ?? '', auth: req.headers.authorization });
  const url = new URL(req.url ?? '/', 'http://stub');
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const dataset = { dataset_id: 'ds_1', name: 'refunds', description: null, created_at: 1, example_count: EXAMPLES.length };
  if (url.pathname === '/api/v1/datasets/refunds') {
    return send(200, { dataset, examples: EXAMPLES.slice(offset, offset + 1), total: EXAMPLES.length, limit: 1, offset });
  }
  if (url.pathname === '/api/v1/datasets/blank') return send(200, { dataset: { ...dataset, name: 'blank', example_count: 0 }, examples: [], total: 0, limit: 1000, offset });
  if (url.pathname === '/api/v1/datasets/broken') return send(200, { dataset });
  if (url.pathname === '/api/v1/datasets/html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<html>not the daemon</html>');
  }
  if (url.pathname.startsWith('/api/v1/datasets/')) return send(404, { error: 'dataset not found', code: 'LOUSHO_REQUEST_INVALID' });
  send(200, {});
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const daemonUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** A port nothing listens on. */
async function deadUrl(): Promise<string> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

async function rejection(promise: Promise<unknown>): Promise<SDKError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(SDKError);
  return error as SDKError;
}

// --- real registrations (LOUSHO_OBSERVE is read when defineEval() is called) ---

const seen: DatasetCase[] = [];
process.env.LOUSHO_OBSERVE = daemonUrl;
process.env.LOUSHO_OBSERVE_TOKEN = 'tok';

defineEval({
  name: 'refunds',
  dataset: 'refunds',
  agent: () => createAgent({ provider: mockModel([(req) => `echo ${String(req.messages.at(-1)?.content)}`]) }),
  async test(t, c) {
    seen.push(c);
    await t.send(String(c.input));
    t.check('echoes', t.reply, equals(c.expected));
  },
});

process.env[TAGS_ENV] = 'nightly';
defineEval({
  name: 'filtered out',
  dataset: 'never-fetched',
  tags: ['smoke'],
  async test() {
    throw new Error('a tag-filtered eval must not run');
  },
});
delete process.env[TAGS_ENV];
delete process.env.LOUSHO_OBSERVE;
delete process.env.LOUSHO_OBSERVE_TOKEN;

describe('defineEval({ dataset })', () => {
  it('ran one case per daemon example, labelled #1, #2, with the example fields', () => {
    expect(seen).toEqual([
      { input: 'refund order 42', expected: 'echo refund order 42', label: '#1', example_id: 'ex_1', source_trace_id: 'tr_9' },
      { input: 'refund order 7', expected: 'echo refund order 7', label: '#2', example_id: 'ex_2', source_trace_id: null },
    ]);
  });

  it('named the tests <eval> [#n], fetched every page with the token, and skipped the filtered eval without a fetch', ({ task }) => {
    const names: Array<{ name: string; mode: string }> = [];
    const walk = (tasks: readonly { name: string; mode: string; type: string; tasks?: unknown[] }[]) => {
      for (const t of tasks) {
        if (t.type === 'suite') walk((t.tasks ?? []) as typeof tasks);
        else names.push({ name: t.name, mode: t.mode });
      }
    };
    walk(task.file!.tasks as never);
    expect(names).toEqual(
      expect.arrayContaining([
        { name: 'refunds [#1]', mode: 'run' },
        { name: 'refunds [#2]', mode: 'run' },
        { name: 'filtered out', mode: 'skip' },
      ])
    );
    const refunds = requests.filter((r) => r.url.startsWith('/api/v1/datasets/refunds'));
    expect(refunds.map((r) => new URL(r.url, 'http://stub').searchParams.get('offset'))).toEqual(['0', '1']);
    expect(refunds.every((r) => r.auth === 'Bearer tok')).toBe(true);
    expect(requests.some((r) => r.url.includes('never-fetched'))).toBe(false);
  });

  it('rejects `cases` and `dataset` together with LOUSHO_EVALS_INVALID', () => {
    let error: unknown;
    try {
      defineEval({ name: 'both', dataset: 'refunds', cases: [{ input: 'x' }], test() {} } as never);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SDKError);
    expect((error as SDKError).code).toBe('LOUSHO_EVALS_INVALID');
  });
});

describe('fetchDatasetCases', () => {
  it('fails with LOUSHO_DATASET_UNAVAILABLE when the daemon is unreachable', async () => {
    const url = await deadUrl();
    const error = await rejection(fetchDatasetCases('refunds', { url }));
    expect(error.code).toBe('LOUSHO_DATASET_UNAVAILABLE');
    expect(error.message).toContain('refunds');
    expect(error.message).toContain(url);
  });

  it('says "not found" and names the dataset and URL for a 404', async () => {
    const error = await rejection(fetchDatasetCases('refundz', { url: daemonUrl }));
    expect(error.code).toBe('LOUSHO_DATASET_UNAVAILABLE');
    expect(error.message).toContain("'refundz'");
    expect(error.message).toContain('not found');
    expect(error.message).toContain(daemonUrl);
  });

  it('fails when LOUSHO_OBSERVE is not set', async () => {
    const error = await rejection(fetchDatasetCases('refunds', { url: undefined }));
    expect(error.code).toBe('LOUSHO_DATASET_UNAVAILABLE');
    expect(error.message).toContain('LOUSHO_OBSERVE');
  });

  it('fails for an empty dataset, so an eval that runs nothing cannot pass', async () => {
    const error = await rejection(fetchDatasetCases('blank', { url: daemonUrl }));
    expect(error.code).toBe('LOUSHO_DATASET_UNAVAILABLE');
    expect(error.message).toContain('empty');
  });

  it('fails for a body without an examples array', async () => {
    const error = await rejection(fetchDatasetCases('broken', { url: daemonUrl }));
    expect(error.code).toBe('LOUSHO_DATASET_UNAVAILABLE');
    expect(error.message).toContain('examples');
  });

  it('fails for a 200 answer that is not JSON', async () => {
    const error = await rejection(fetchDatasetCases('html', { url: daemonUrl }));
    expect(error.code).toBe('LOUSHO_DATASET_UNAVAILABLE');
    expect(error.message).toContain('examples');
  });

  it('closes the stub daemon', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
