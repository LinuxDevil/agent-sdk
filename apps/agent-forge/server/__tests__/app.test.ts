import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import request from 'supertest';
import type { AgentSpec } from '@loushy/build-ai-agent';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';

const SPEC: AgentSpec = {
  name: 'test-agent',
  prompt: 'You are a helpful agent.',
  provider: { type: 'mock', model: 'mock-1' },
};

function waitForStatus(
  runManager: RunManager,
  agentId: string,
  predicate: (status: { status: string }) => boolean,
  timeoutMs = 2000
): Promise<any> {
  // The mock provider resolves near-instantly, so a run kicked off by an
  // earlier `await request(app)...` call may already have reached its
  // terminal status before this helper's listener is attached - check the
  // current status first rather than only listening for a future
  // transition that may never come.
  const current = runManager.status(agentId);
  if (predicate(current)) return Promise.resolve(current);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      runManager.off('status', onStatus);
      reject(new Error('Timed out waiting for status'));
    }, timeoutMs);
    function onStatus(payload: any) {
      if (payload.agentId !== agentId) return;
      if (predicate(payload)) {
        clearTimeout(timer);
        runManager.off('status', onStatus);
        resolve(payload);
      }
    }
    runManager.on('status', onStatus);
  });
}

describe('LOU-N HTTP API', () => {
  let baseDir: string;
  let app: ReturnType<typeof createApp>;
  let runManager: RunManager;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-n-app-test-'));
    const agentStore = createFsAgentStore(baseDir);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: (id) => agentStore.load(id),
      saveSpec: (id, spec) => agentStore.save(id, spec),
    });
    app = createApp({ agentStore, runManager });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.text).toBe('ok');
  });

  it('GET /agents/:id/status returns idle before any run', async () => {
    const res = await request(app).get('/agents/nope/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('idle');
  });

  it('rejects a path-traversal agent id instead of writing outside .loushy/agents', async () => {
    // Express URL-decodes `:id` before handing it to the route, so a
    // percent-encoded `..%2F..%2Fpwned` arrives as a plain string
    // containing `/` and `..` - without the isValidAgentId guard in app.ts,
    // this would let PUT /agents/:id escape `.loushy/agents/` via
    // fsAgentStore.ts's path.join(agentsDir, `${id}.yaml`).
    const traversalId = encodeURIComponent('../../pwned');
    const put = await request(app).put(`/agents/${traversalId}`).send(SPEC);
    expect(put.status).toBe(400);

    const escapedFile = path.join(baseDir, '..', 'pwned.yaml');
    expect(fs.existsSync(escapedFile)).toBe(false);

    const run = await request(app).post(`/agents/${traversalId}/run`).send({ input: 'hi', spec: SPEC });
    expect(run.status).toBe(400);

    const status = await request(app).get(`/agents/${traversalId}/status`);
    expect(status.status).toBe(400);
  });

  it('PUT then GET round-trips an AgentSpec', async () => {
    const put = await request(app).put('/agents/foo').send(SPEC);
    expect(put.status).toBe(204);

    const get = await request(app).get('/agents/foo');
    expect(get.status).toBe(200);
    expect(get.body.name).toBe('test-agent');
  });

  it('PUT /agents/:id rejects a malformed spec', async () => {
    const res = await request(app).put('/agents/foo').send({ nonsense: true });
    expect(res.status).toBe(400);
  });

  it('POST /agents/:id/run starts a run and GET /status reflects it finishing', async () => {
    const run = await request(app).post('/agents/bar/run').send({ spec: SPEC, input: 'hello' });
    expect(run.status).toBe(202);
    expect(['running', 'stopped']).toContain(run.body.status);

    const final = await waitForStatus(runManager, 'bar', (s) => s.status === 'stopped');
    expect(final.resultText).toBeTruthy();

    const status = await request(app).get('/agents/bar/status');
    expect(status.body.status).toBe('stopped');
  });

  it('POST /agents/:id/run without input is rejected', async () => {
    const res = await request(app).post('/agents/bar/run').send({ spec: SPEC });
    expect(res.status).toBe(400);
  });

  // The "already running" 409 guard itself is covered deterministically at
  // the RunManager unit level (runRegistry.test.ts) by calling run() twice
  // back-to-back with no intervening await. Reproducing that race through
  // a real HTTP round-trip (supertest) against the near-instant mock
  // provider is flaky: enough real event-loop turns elapse between the two
  // requests that the first run can legitimately finish before the second
  // one is even dispatched, so this is intentionally not re-tested here.

  it('POST /agents/:id/run for an agent with no saved spec and no spec in the body returns 404', async () => {
    const res = await request(app).post('/agents/ghost/run').send({ input: 'hi' });
    expect(res.status).toBe(404);
  });

  it('POST /agents/:id/stop on an idle agent is a safe no-op (202)', async () => {
    const res = await request(app).post('/agents/never-ran/stop');
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('idle');
  });

  it('POST /agents/:id/approve with no pending approval returns 409', async () => {
    const res = await request(app)
      .post('/agents/none-pending/approve')
      .send({ approvalId: 'x', approved: true });
    expect(res.status).toBe(409);
  });

  it('POST /agents/:id/approve with a bad body returns 400', async () => {
    const res = await request(app).post('/agents/foo/approve').send({ approvalId: 'x' });
    expect(res.status).toBe(400);
  });
});
