import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
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

const SPEC: AgentSpecV2 = { version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'Check the queues.' };
const ORIGIN = 'http://localhost:3000';

describe('serve widget key (X04b)', () => {
  let baseDir: string;
  let studioHome: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-x04b-key-'));
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
    createApp({
      agentStore,
      runManager,
      baseDir,
      studioHome,
      secretsStore: new SecretsStore(paths()),
      settingsStore: new SettingsStore(paths()),
      spendLog: new SpendLog(paths().spend),
    });

  /** Publishes, enables serving with one allowed origin, and returns the raw serve token. */
  async function enableServing(): Promise<string> {
    await request(app()).post('/agents/ops/publish').send({});
    await request(app()).put('/agents/ops/serve').send({ enabled: true, allowedOrigins: [ORIGIN] });
    const token = await request(app()).get('/agents/ops/serve/token');
    return token.body.token as string;
  }

  async function createKey(): Promise<string> {
    const res = await request(app()).post('/agents/ops/serve/widget-key').send({});
    expect(res.status).toBe(200);
    return res.body.widgetKey as string;
  }

  const chat = (key: string, origin?: string) => {
    const req = request(app())
      .post('/serve/ops/chat')
      .set('authorization', `Bearer ${key}`)
      .send({ sessionId: 's1', input: 'hi' });
    return origin === undefined ? req : req.set('origin', origin);
  };

  it('creates an fwk_ key, masks it in status, and rotates on a second POST', async () => {
    await enableServing();
    const status0 = (await request(app()).get('/agents/ops/serve')).body as ServeStatus;
    expect(status0.widgetKeyMasked).toBeNull();

    const first = await createKey();
    expect(first).toMatch(/^fwk_/);
    const status1 = (await request(app()).get('/agents/ops/serve')).body as ServeStatus;
    expect(status1.widgetKeyMasked).not.toBeNull();
    expect(status1.widgetKeyMasked).not.toContain(first);

    const second = await createKey();
    expect(second).not.toBe(first);
    // The rotated-out key no longer works.
    const stale = await chat(first, ORIGIN);
    expect(stale.status).toBe(401);
  });

  it('DELETE revokes the key', async () => {
    await enableServing();
    const key = await createKey();
    expect((await chat(key, ORIGIN)).status).toBe(200);
    const del = await request(app()).delete('/agents/ops/serve/widget-key');
    expect(del.status).toBe(204);
    const status = (await request(app()).get('/agents/ops/serve')).body as ServeStatus;
    expect(status.widgetKeyMasked).toBeNull();
    expect((await chat(key, ORIGIN)).status).toBe(401);
  });

  it('accepts the key on POST /serve/:id/chat from an allowed origin', async () => {
    await enableServing();
    const key = await createKey();
    const res = await chat(key, ORIGIN);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.text).toContain('event: done');
  });

  it('401s LOUSHO_WIDGET_KEY_SCOPE on every non-chat serve route', async () => {
    await enableServing();
    const key = await createKey();
    for (const attempt of [
      request(app()).get('/serve/ops/chat').set('authorization', `Bearer ${key}`).set('origin', ORIGIN),
      request(app()).post('/serve/ops/sessions').set('authorization', `Bearer ${key}`).set('origin', ORIGIN),
      request(app()).get('/serve/ops/health').set('authorization', `Bearer ${key}`).set('origin', ORIGIN),
    ]) {
      const res = await attempt;
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('LOUSHO_WIDGET_KEY_SCOPE');
    }
  });

  it('403s LOUSHO_WIDGET_ORIGIN on a missing or unlisted origin', async () => {
    await enableServing();
    const key = await createKey();
    const missing = await chat(key);
    expect(missing.status).toBe(403);
    expect(missing.body.code).toBe('LOUSHO_WIDGET_ORIGIN');
    const foreign = await chat(key, 'https://evil.example');
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe('LOUSHO_WIDGET_ORIGIN');
  });

  it('the serve token still works everywhere, with or without an origin', async () => {
    const token = await enableServing();
    const noOrigin = await request(app())
      .post('/serve/ops/chat')
      .set('authorization', `Bearer ${token}`)
      .send({ sessionId: 's1', input: 'hi' });
    expect(noOrigin.status).toBe(200);
    const other = await request(app())
      .get('/serve/ops/health')
      .set('authorization', `Bearer ${token}`)
      .set('origin', ORIGIN);
    expect(other.status).toBe(200);
  });
});
