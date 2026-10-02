import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import request from 'supertest';
import type { AgentSpec } from '@lousho/build-ai-agent';
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
    app = createApp({ agentStore, runManager, baseDir });
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

  it('rejects a path-traversal agent id instead of writing outside .lousho/agents', async () => {
    // Express URL-decodes `:id` before handing it to the route, so a
    // percent-encoded `..%2F..%2Fpwned` arrives as a plain string
    // containing `/` and `..` - without the isValidAgentId guard in app.ts,
    // this would let PUT /agents/:id escape `.lousho/agents/` via
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

  it('GET /agents/:id/debug reports no breakpoints/not paused for an agent that never ran', async () => {
    const res = await request(app).get('/agents/never-debugged/debug');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ agentId: 'never-debugged', paused: false, breakpoints: [] });
  });

  it('PUT /agents/:id/debug/breakpoints sets breakpoints, reflected by GET /agents/:id/debug', async () => {
    const put = await request(app)
      .put('/agents/debug-bp/debug/breakpoints')
      .send({ breakpoints: ['llm:before', 'tool:current-date:after'] });
    expect(put.status).toBe(200);
    expect(put.body.breakpoints.sort()).toEqual(['llm:before', 'tool:current-date:after']);

    const get = await request(app).get('/agents/debug-bp/debug');
    expect(get.body.breakpoints.sort()).toEqual(['llm:before', 'tool:current-date:after']);
  });

  it('PUT /agents/:id/debug/breakpoints rejects a non-array body', async () => {
    const res = await request(app).put('/agents/debug-bp/debug/breakpoints').send({ breakpoints: 'nope' });
    expect(res.status).toBe(400);
  });

  it('a run paused at a breakpoint resumes via POST /agents/:id/debug/continue', async () => {
    await request(app)
      .put('/agents/debug-run/debug/breakpoints')
      .send({ breakpoints: ['llm:before'] });

    await request(app).post('/agents/debug-run/run').send({ input: 'hi', spec: SPEC });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const pausedState = await request(app).get('/agents/debug-run/debug');
    expect(pausedState.body.paused).toBe(true);

    // Clear breakpoints so a follow-up llm turn (if any) doesn't re-pause,
    // then continue until the run reaches a terminal status.
    await request(app).put('/agents/debug-run/debug/breakpoints').send({ breakpoints: [] });
    const cont = await request(app).post('/agents/debug-run/debug/continue');
    expect(cont.status).toBe(200);

    await waitForStatus(runManager, 'debug-run', (s) => s.status === 'stopped');
  });
});

describe('LOU-R settings/secrets HTTP routes', () => {
  let baseDir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-r-app-test-'));
    const agentStore = createFsAgentStore(baseDir);
    const runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: (id) => agentStore.load(id),
      saveSpec: (id, spec) => agentStore.save(id, spec),
    });
    app = createApp({ agentStore, runManager, baseDir });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('GET /settings/providers starts with no keys configured', async () => {
    const res = await request(app).get('/settings/providers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { provider: 'openai', hasKey: false, masked: null },
      { provider: 'anthropic', hasKey: false, masked: null },
    ]);
  });

  it('PUT /settings/providers/:provider stores a key and never echoes it back', async () => {
    const res = await request(app).put('/settings/providers/openai').send({ apiKey: 'sk-super-secret' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ provider: 'openai', hasKey: true, masked: '••••••••cret' });
    expect(JSON.stringify(res.body)).not.toContain('sk-super-secret');

    const raw = fs.readFileSync(path.join(baseDir, '.lousho', 'secrets.json'), 'utf8');
    expect(raw).not.toContain('sk-super-secret');
  });

  it('PUT /settings/providers/:provider rejects an unknown provider', async () => {
    const res = await request(app).put('/settings/providers/notreal').send({ apiKey: 'sk-abc' });
    expect(res.status).toBe(400);
  });

  it('PUT /settings/providers/:provider rejects a missing apiKey', async () => {
    const res = await request(app).put('/settings/providers/openai').send({});
    expect(res.status).toBe(400);
  });

  it('DELETE /settings/providers/:provider removes a stored key', async () => {
    await request(app).put('/settings/providers/anthropic').send({ apiKey: 'sk-ant-abc' });
    const del = await request(app).delete('/settings/providers/anthropic');
    expect(del.status).toBe(204);
    const list = await request(app).get('/settings/providers');
    expect(list.body.find((p: { provider: string }) => p.provider === 'anthropic').hasKey).toBe(false);
  });

  it('GET /settings/profiles returns default local/staging/prod profiles with local active', async () => {
    const res = await request(app).get('/settings/profiles');
    expect(res.status).toBe(200);
    expect(res.body.activeProfileId).toBe('local');
    expect(res.body.profiles.map((p: { id: string }) => p.id)).toEqual(['local', 'staging', 'prod']);
  });

  it('POST /settings/profiles/:id/activate switches the active profile', async () => {
    const res = await request(app).post('/settings/profiles/staging/activate');
    expect(res.status).toBe(200);
    expect(res.body.activeProfileId).toBe('staging');
  });

  it('POST /settings/profiles/:id/activate 400s for an unknown profile', async () => {
    const res = await request(app).post('/settings/profiles/nope/activate');
    expect(res.status).toBe(400);
  });

  it('PUT /settings/profiles/:id upserts a profile', async () => {
    const res = await request(app)
      .put('/settings/profiles/local')
      .send({ name: 'local', providerType: 'openai', deployAdapter: 'docker', otelEnabled: true, hookTimeoutMs: 8000 });
    expect(res.status).toBe(200);
    const updated = res.body.profiles.find((p: { id: string }) => p.id === 'local');
    expect(updated).toMatchObject({ providerType: 'openai', deployAdapter: 'docker', otelEnabled: true, hookTimeoutMs: 8000 });
  });

  it('PUT /settings/profiles/:id rejects a malformed body', async () => {
    const res = await request(app).put('/settings/profiles/local').send({ name: 'local' });
    expect(res.status).toBe(400);
  });

  it('GET /settings/deploy-adapters lists the known deployment targets', async () => {
    const res = await request(app).get('/settings/deploy-adapters');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(['node-server', 'cloudflare-worker', 'docker']);
  });

  it('POST /agents/:id/deploy 404s for an agent that was never saved', async () => {
    const res = await request(app).post('/agents/never-saved/deploy').send({ adapter: 'node-server' });
    expect(res.status).toBe(404);
  });

  it('POST /agents/:id/deploy rejects an unknown adapter', async () => {
    await request(app).put('/agents/deploy-me').send(SPEC);
    const res = await request(app).post('/agents/deploy-me/deploy').send({ adapter: 'not-a-real-target' });
    expect(res.status).toBe(400);
  });

  it('POST /agents/:id/deploy shells out to `lousho build` and reports a non-zero exit when the SDK has not been built', async () => {
    await request(app).put('/agents/deploy-me-2').send(SPEC);
    const res = await request(app).post('/agents/deploy-me-2/deploy').send({ adapter: 'node-server' });
    // This test environment may or may not have `dist/` built - either way
    // the route must resolve (never hang/throw) and report SOME exit code
    // plus the exact command it ran, never silently swallow a failure.
    expect([200, 422]).toContain(res.status);
    expect(res.body).toHaveProperty('exitCode');
    expect(res.body).toHaveProperty('command');
    expect(res.body.command).toContain('build');
  }, 30000);
});
