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

const SPEC: AgentSpecV2 = { version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'Check the queues.' };

describe('GET /serve/:id/widget.js (X04b)', () => {
  let baseDir: string;
  let studioHome: string;
  let widgetDir: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-x04b-widget-'));
    studioHome = path.join(baseDir, '.lousho');
    widgetDir = path.join(baseDir, 'widget');
    fs.mkdirSync(widgetDir, { recursive: true });
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
      widgetDir,
      secretsStore: new SecretsStore(paths()),
      settingsStore: new SettingsStore(paths()),
      spendLog: new SpendLog(paths().spend),
    });

  async function enableServing(): Promise<void> {
    await request(app()).post('/agents/ops/publish').send({});
    await request(app()).put('/agents/ops/serve').send({ enabled: true });
  }

  it('serves the built bundle with JS content type and a public cache header - no token needed', async () => {
    fs.writeFileSync(path.join(widgetDir, 'forge-chat.js'), '/* forge-chat */ customElements.define("forge-chat", class {})');
    await enableServing();
    const res = await request(app()).get('/serve/ops/widget.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.text).toContain('forge-chat');
  });

  it('404s LOUSHO_WIDGET_MISSING when the bundle was never built', async () => {
    await enableServing();
    const res = await request(app()).get('/serve/ops/widget.js');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Widget not built. Run npm run build:studio.', code: 'LOUSHO_WIDGET_MISSING' });
  });

  it('404s LOUSHO_NOT_SERVED when serving is disabled, and 400 on a bad id', async () => {
    fs.writeFileSync(path.join(widgetDir, 'forge-chat.js'), 'x');
    await request(app()).post('/agents/ops/publish').send({});
    const disabled = await request(app()).get('/serve/ops/widget.js');
    expect(disabled.status).toBe(404);
    expect(disabled.body.code).toBe('LOUSHO_NOT_SERVED');
    const bad = await request(app()).get('/serve/NOPE!/widget.js');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('LOUSHO_AGENT_ID_INVALID');
  });
});
