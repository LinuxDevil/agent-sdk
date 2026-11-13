import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { AgentSpec } from 'lousho';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { AlertStore } from '../inbox/alertStore';
import type { InboxItem } from '../../shared/wireTypes';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';
import { workspaceIdFor } from '../workspace/workspaceId';
import { regressionsDatasetName } from '../ratings';

const V1_SPEC: AgentSpec = {
  name: 'ops',
  prompt: 'Check the queues.',
  provider: { type: 'mock', model: 'mock-1' },
};

/** A fetch stub answering by path suffix; records every call. */
function daemonFetch(handlers: Record<string, () => Response>) {
  const calls: { url: string; body: unknown }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    for (const [suffix, respond] of Object.entries(handlers)) {
      if (url.endsWith(suffix)) return respond();
    }
    return new Response(JSON.stringify({ error: `unstubbed ${url}` }), { status: 500 });
  });
  return { fn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('rating routes', () => {
  let baseDir: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;
  let alerts: AlertStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-r04a-rating-'));
    agentStore = createFsAgentStore(baseDir);
    repo = new AgentRepo(baseDir);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
    alerts = new AlertStore(path.join(baseDir, '.lousho', 'inbox', 'alerts.json'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const app = () => createApp({ agentStore, runManager, baseDir, alerts });

  const saveAgent = async (id = 'ops') => {
    const res = await request(app()).put(`/agents/${id}`).send(V1_SPEC);
    expect(res.status).toBe(204);
  };

  const rate = (id: string, body: string | object) => request(app()).post(`/agents/${id}/rating`).send(body);

  it('POST /agents/:id/rating validates the body', async () => {
    for (const body of [
      {},
      { traceId: '', value: 3 },
      { traceId: 't'.repeat(201), value: 3 },
      { traceId: 'tr1', value: 0 },
      { traceId: 'tr1', value: 6 },
      { traceId: 'tr1', value: 2.5 },
      { traceId: 'tr1', value: '4' },
      { traceId: 'tr1', value: 3, comment: 'x'.repeat(2001) },
      { traceId: 'tr1', value: 3, comment: 42 },
      'nope',
    ] as (string | object)[]) {
      const res = await rate('ops', body);
      expect(res.status).toBe(400);
    }
  });

  it('a rating of 4 posts one `rating` score to the daemon and raises no alert', async () => {
    const { fn, calls } = daemonFetch({ '/api/v1/scores': () => json(201, { score_id: 's1' }) });
    vi.stubGlobal('fetch', fn);

    const res = await rate('ops', { traceId: 'tr1', value: 4 });
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/api\/v1\/scores$/);
    expect(calls[0].body).toEqual({ trace_id: 'tr1', name: 'rating', value: 4 });
    expect(await alerts.list()).toHaveLength(0);
  });

  it('a rating of 1 with a comment posts the score and raises a low_rating alert visible in GET /inbox', async () => {
    await saveAgent();
    const { fn, calls } = daemonFetch({ '/api/v1/scores': () => json(201, { score_id: 's1' }) });
    vi.stubGlobal('fetch', fn);

    const res = await rate('ops', { traceId: 'tr1', value: 1, comment: 'It gave up immediately.' });
    expect(res.status).toBe(204);
    expect(calls[0].body).toMatchObject({ trace_id: 'tr1', name: 'rating', value: 1, comment: 'It gave up immediately.' });

    const stored = await alerts.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      kind: 'low_rating',
      agentId: 'ops',
      workspaceId: workspaceIdFor(baseDir),
      title: 'Run rated 1 (Poor)',
      detail: 'It gave up immediately.',
      payload: { traceId: 'tr1', value: 1, comment: 'It gave up immediately.' },
    });

    const inbox = await request(app()).get('/inbox');
    expect(inbox.status).toBe(200);
    const alertItem = (inbox.body as InboxItem[]).find((item) => item.kind === 'alert');
    expect(alertItem).toMatchObject({ alertKind: 'low_rating', agentId: 'ops' });
  });

  it('passes the daemon 404 through as "No trace"', async () => {
    const { fn } = daemonFetch({ '/api/v1/scores': () => json(404, { error: 'missing', code: 'LOUSHO_REQUEST_INVALID' }) });
    vi.stubGlobal('fetch', fn);
    const res = await rate('ops', { traceId: 'gone', value: 5 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("No trace 'gone'");
  });

  it('answers 502 LOUSHO_OBSERVE_DOWN when the daemon is unreachable and writes nothing locally', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    const res = await rate('ops', { traceId: 'tr1', value: 1, comment: 'bad' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('LOUSHO_OBSERVE_DOWN');
    expect(await alerts.list()).toHaveLength(0);
  });

  const addLowRatingAlert = (over: Record<string, unknown> = {}) =>
    alerts.add({
      kind: 'low_rating',
      agentId: 'ops',
      workspaceId: workspaceIdFor(baseDir),
      title: 'Run rated 1 (Poor)',
      detail: null,
      payload: { traceId: 'tr1', value: 1, comment: null },
      ...over,
    });

  const addToDataset = (id: string, alertId: string) =>
    request(app()).post(`/agents/${id}/rating/${alertId}/dataset`);

  it('the dataset action creates <agent>-regressions then appends the trace as an example', async () => {
    const alert = await addLowRatingAlert();
    const { fn, calls } = daemonFetch({
      '/api/v1/datasets': () => json(201, { dataset: { dataset_id: 'd1' } }),
      '/examples': () => json(201, { example: { example_id: 'ex1' } }),
    });
    vi.stubGlobal('fetch', fn);

    const res = await addToDataset('ops', alert.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ dataset: 'ops-regressions', exampleId: 'ex1' });
    expect(calls[0].body).toMatchObject({ name: 'ops-regressions' });
    expect(calls[1].url).toContain('/api/v1/datasets/ops-regressions/examples');
    expect(calls[1].body).toEqual({ from_trace_id: 'tr1' });
  });

  it('a 409 on dataset create still appends the example (create-or-reuse)', async () => {
    const alert = await addLowRatingAlert();
    const { fn } = daemonFetch({
      '/api/v1/datasets': () => json(409, { error: 'exists', code: 'LOUSHO_REQUEST_INVALID' }),
      '/examples': () => json(201, { example: { example_id: 'ex9' } }),
    });
    vi.stubGlobal('fetch', fn);
    const res = await addToDataset('ops', alert.id);
    expect(res.status).toBe(200);
    expect(res.body.exampleId).toBe('ex9');
  });

  it('maps the daemon "no captured input" 400 to 422 LOUSHO_TRACE_NO_INPUT', async () => {
    const alert = await addLowRatingAlert();
    const { fn } = daemonFetch({
      '/api/v1/datasets': () => json(201, {}),
      '/examples': () => json(400, { error: "Trace 'tr1' has no captured input (content capture was off).", code: 'LOUSHO_REQUEST_INVALID' }),
    });
    vi.stubGlobal('fetch', fn);
    const res = await addToDataset('ops', alert.id);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LOUSHO_TRACE_NO_INPUT');
  });

  it('404s an unknown, dismissed, other-agent or non-rating alert', async () => {
    const { fn } = daemonFetch({});
    vi.stubGlobal('fetch', fn);
    expect((await addToDataset('ops', 'alert_nope')).status).toBe(404);

    const other = await addLowRatingAlert({ agentId: 'other' });
    expect((await addToDataset('ops', other.id)).status).toBe(404);

    const dismissed = await addLowRatingAlert();
    await alerts.dismiss(dismissed.id);
    expect((await addToDataset('ops', dismissed.id)).status).toBe(404);

    const autoOff = await alerts.add({
      kind: 'auto_disabled',
      agentId: 'ops',
      workspaceId: workspaceIdFor(baseDir),
      title: 'x',
      detail: null,
      payload: {},
    });
    expect((await addToDataset('ops', autoOff.id)).status).toBe(404);
    expect(fn).not.toHaveBeenCalled();
  });

  it('regressionsDatasetName cuts the id part to keep the suffix inside 200 chars', () => {
    const name = regressionsDatasetName('a'.repeat(300));
    expect(name).toHaveLength(200);
    expect(name.endsWith('-regressions')).toBe(true);
    expect(regressionsDatasetName('ops')).toBe('ops-regressions');
  });
});
