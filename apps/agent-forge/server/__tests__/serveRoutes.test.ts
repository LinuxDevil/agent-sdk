import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { AgentSpecV2 } from 'lousho';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { SecretsStore } from '../secretsStore';
import { SettingsStore } from '../settingsStore';
import { SpendLog } from '../passes/spendLog';
import { studioPathsFor } from '../workspace/studioPaths';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';
import type { ServeStatus } from '../../shared/wireTypes';
import { buildServeAgent, type ServeAgentBuilder } from '../serve/serveRoutes';

const SPEC: AgentSpecV2 = { version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'Check the queues.' };

describe('/serve/<id> published-agent surface (X02a)', () => {
  let baseDir: string;
  let studioHome: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;
  let builds: number;
  // One app per test: each createApp() gets a fresh serve-handler cache, so
  // tests that assert rebuild/caching behaviour must reuse the instance.
  let instance: ReturnType<typeof createApp> | undefined;

  const countingBuilder: ServeAgentBuilder = async (spec, agentId, workspace, services) => {
    builds += 1;
    return buildServeAgent(spec, agentId, workspace, services);
  };

  beforeEach(async () => {
    builds = 0;
    instance = undefined;
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-x02a-serve-'));
    studioHome = path.join(baseDir, '.lousho');
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
    await repo.writeSpec('ops', SPEC);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const paths = () => studioPathsFor(studioHome);
  const app = () =>
    (instance ??= createApp({
      agentStore,
      runManager,
      baseDir,
      studioHome,
      secretsStore: new SecretsStore(paths()),
      settingsStore: new SettingsStore(paths()),
      spendLog: new SpendLog(paths().spend),
      serveAgentBuilder: countingBuilder,
    }));

  /** Writes the spec, publishes it (v1), enables serving and returns the raw token. */
  async function enableServing(allowedOrigins: string[] = []): Promise<string> {
    const publish = await request(app()).post('/agents/ops/publish').send({});
    expect(publish.status).toBe(200);
    const put = await request(app()).put('/agents/ops/serve').send({ enabled: true, allowedOrigins });
    expect(put.status).toBe(200);
    const token = await request(app()).get('/agents/ops/serve/token');
    expect(token.status).toBe(200);
    return token.body.token as string;
  }

  it('GET /agents/:id/serve reports config, masked token and the publish pointer', async () => {
    await request(app()).post('/agents/ops/publish').send({});
    const put = await request(app()).put('/agents/ops/serve').send({ enabled: true, allowedOrigins: ['https://app.example'] });
    expect(put.status).toBe(200);
    const status = put.body as ServeStatus;
    expect(status).toMatchObject({
      agentId: 'ops',
      enabled: true,
      allowedOrigins: ['https://app.example'],
      publishedVersion: 1,
      baseUrl: '/serve/ops',
    });
    expect(status.tokenMasked).toMatch(/^.{4}….{4}$/);
    expect(status.tokenMasked).not.toContain((await request(app()).get('/agents/ops/serve/token')).body.token);
  });

  it('PUT validates origins and answers 400 LOUSHO_REQUEST_INVALID', async () => {
    const bad = await request(app()).put('/agents/ops/serve').send({ allowedOrigins: ['https://app.example/chat'] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('LOUSHO_REQUEST_INVALID');
    const tooMany = await request(app())
      .put('/agents/ops/serve')
      .send({ allowedOrigins: Array.from({ length: 11 }, (_, i) => `https://o${i}.example`) });
    expect(tooMany.status).toBe(400);
  });

  it('answers 404 LOUSHO_NOT_SERVED when disabled or unpublished', async () => {
    // Published but not enabled.
    await request(app()).post('/agents/ops/publish').send({});
    const disabled = await request(app()).get('/serve/ops/chat');
    expect(disabled.status).toBe(404);
    expect(disabled.body).toEqual({ error: 'Not served', code: 'LOUSHO_NOT_SERVED' });

    // Enabled but nothing published.
    await repo.writeSpec('ghost', SPEC);
    await request(app()).put('/agents/ghost/serve').send({ enabled: true });
    const unpublished = await request(app()).get('/serve/ghost/chat');
    expect(unpublished.status).toBe(404);
    expect(unpublished.body.code).toBe('LOUSHO_NOT_SERVED');
  });

  it('streams an authenticated chat turn ending in event: done', async () => {
    const token = await enableServing();
    const res = await request(app())
      .post('/serve/ops/chat')
      .set('authorization', `Bearer ${token}`)
      .send({ sessionId: 's1', input: 'hi' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('event: done');
    expect(builds).toBe(1);
  });

  it('rejects a missing or wrong bearer with the SDK 401', async () => {
    const token = await enableServing();
    const missing = await request(app()).post('/serve/ops/chat').send({ sessionId: 's1', input: 'hi' });
    expect(missing.status).toBe(401);
    const wrong = await request(app())
      .post('/serve/ops/chat')
      .set('authorization', 'Bearer wrong-token')
      .send({ sessionId: 's1', input: 'hi' });
    expect(wrong.status).toBe(401);
    expect(token.length).toBeGreaterThan(0);
  });

  it('rejects a foreign Host with 403 before the router runs', async () => {
    const token = await enableServing();
    const res = await request(app())
      .post('/serve/ops/chat')
      .set('host', 'evil.example.com')
      .set('authorization', `Bearer ${token}`)
      .send({ sessionId: 's1', input: 'hi' });
    expect(res.status).toBe(403);
  });

  it('403s a disallowed Origin and answers CORS + preflight for an allowed one', async () => {
    const token = await enableServing(['https://app.example']);
    const bad = await request(app())
      .post('/serve/ops/chat')
      .set('origin', 'https://evil.example')
      .set('authorization', `Bearer ${token}`)
      .send({ sessionId: 's1', input: 'hi' });
    expect(bad.status).toBe(403);
    expect(bad.body.code).toBe('LOUSHO_REQUEST_FORBIDDEN');

    const preflight = await request(app())
      .options('/serve/ops/chat')
      .set('origin', 'https://app.example')
      .set('access-control-request-method', 'POST');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://app.example');

    const ok = await request(app())
      .post('/serve/ops/chat')
      .set('origin', 'https://app.example')
      .set('authorization', `Bearer ${token}`)
      .send({ sessionId: 's1', input: 'hi' });
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.example');
    expect(ok.text).toContain('event: done');
  });

  it('rebuilds the handler when a new version is published, and rotate-token kills the old bearer', async () => {
    const token = await enableServing();
    await request(app()).post('/serve/ops/chat').set('authorization', `Bearer ${token}`).send({ sessionId: 's1', input: 'hi' }).expect(200);
    expect(builds).toBe(1);

    // Same published version: the cached handler serves, no rebuild.
    await request(app()).post('/serve/ops/chat').set('authorization', `Bearer ${token}`).send({ sessionId: 's1', input: 'again' }).expect(200);
    expect(builds).toBe(1);

    // Publish v2 (drift + publish) → next request rebuilds.
    await repo.writeSpec('ops', { ...SPEC, instructions: 'Changed.' });
    const republish = await request(app()).post('/agents/ops/publish').send({});
    expect(republish.status).toBe(200);
    expect(republish.body.publishedVersion).toBe(2);
    await request(app()).post('/serve/ops/chat').set('authorization', `Bearer ${token}`).send({ sessionId: 's1', input: 'v2' }).expect(200);
    expect(builds).toBe(2);

    // Rotate: old token dies immediately, new one works.
    const rotated = await request(app()).post('/agents/ops/serve/rotate-token').send({});
    expect(rotated.status).toBe(200);
    const newToken = rotated.body.token as string;
    expect(newToken).not.toBe(token);
    await request(app()).post('/serve/ops/chat').set('authorization', `Bearer ${token}`).send({ sessionId: 's1', input: 'old' }).expect(401);
    await request(app()).post('/serve/ops/chat').set('authorization', `Bearer ${newToken}`).send({ sessionId: 's1', input: 'new' }).expect(200);
    // The rebuild after rotation counts as a third build (handler was dropped).
    expect(builds).toBe(3);
  });

  it('persists serve sessions under .lousho/agents/<id>/serve-sessions', async () => {
    const token = await enableServing();
    await request(app())
      .post('/serve/ops/chat')
      .set('authorization', `Bearer ${token}`)
      .send({ sessionId: 'persisted-session', input: 'hi' })
      .expect(200);
    const dir = path.join(baseDir, '.lousho', 'agents', 'ops', 'serve-sessions');
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(dir).length).toBeGreaterThan(0);
  });

  it('validates the agent id in the serve path itself', async () => {
    const res = await request(app()).get(`/serve/${encodeURIComponent('../escape')}/chat`);
    // Express decodes %2F - the id segment can't smuggle a slash, but a bad
    // token still 400s through isValidAgentId inside the router.
    expect([400, 404]).toContain(res.status);
  });
});
