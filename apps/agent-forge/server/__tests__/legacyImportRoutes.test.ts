import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../app';
import { STUDIO_TOKEN_HEADER } from '../auth';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { WorkspaceRegistry } from '../workspace/workspaceRegistry';
import { SecretsStore } from '../secretsStore';
import { SettingsStore } from '../settingsStore';
import { studioPathsFor } from '../workspace/studioPaths';
import type { LegacyImportResult, LegacyImportStatus } from '../../shared/wireTypes';

const TOKEN = 'w03a-routes-token-0123456789';

/**
 * `GET/POST /workspaces/:ws/legacy-import` and `.../skip` (W03a): the
 * one-time offer to copy a workspace's old project-level settings/secrets
 * into the Studio home. `:ws` must be a registered workspace (404 like
 * the rest of `/workspaces`), an empty offer 409s, and every route sits
 * behind the studio token like the registry routes themselves.
 */
describe('/workspaces/:ws/legacy-import routes', () => {
  let baseDir: string;
  let studioHome: string;
  let app: Express;
  let registry: WorkspaceRegistry;
  let wsId: string;
  let wsRoot: string;

  const authed = (req: request.Test) => req.set(STUDIO_TOKEN_HEADER, TOKEN);

  function seedLegacyFiles(): void {
    const settings = new SettingsStore(wsRoot);
    settings.upsertProfile({
      id: 'legacy-acme',
      name: 'legacy-acme',
      providerType: 'openai',
      providerKeyRef: 'openai',
      deployAdapter: 'node-server',
      otelEnabled: false,
      hookTimeoutMs: 5000,
      sandboxBackend: 'noop',
    });
    const secrets = new SecretsStore(wsRoot);
    secrets.setKey('openai', 'sk-old-key');
    secrets.setSecret('GITHUB_TOKEN', 'ghp_old');
  }

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w03a-base-'));
    studioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w03a-home-'));
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w03a-ws-'));
    const repo = new AgentRepo(baseDir);
    const agentStore = createFsAgentStore(baseDir, repo);
    const runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
    registry = new WorkspaceRegistry(path.join(studioHome, 'workspaces.json'));
    await registry.ensure(baseDir);
    wsId = (await registry.add(wsRoot)).id;
    app = createApp({
      agentStore,
      runManager,
      baseDir,
      studioHome,
      workspaceRegistry: registry,
      access: { token: TOKEN },
    });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(studioHome, { recursive: true, force: true });
    fs.rmSync(wsRoot, { recursive: true, force: true });
  });

  it('every route needs the studio token', async () => {
    expect((await request(app).get(`/workspaces/${wsId}/legacy-import`)).status).toBe(401);
    expect((await request(app).post(`/workspaces/${wsId}/legacy-import`)).status).toBe(401);
    expect((await request(app).post(`/workspaces/${wsId}/legacy-import/skip`)).status).toBe(401);
  });

  it('404s an unregistered workspace on all three routes', async () => {
    expect((await authed(request(app).get('/workspaces/ghost-abc123/legacy-import'))).status).toBe(404);
    expect((await authed(request(app).post('/workspaces/ghost-abc123/legacy-import'))).status).toBe(404);
    expect((await authed(request(app).post('/workspaces/ghost-abc123/legacy-import/skip'))).status).toBe(404);
  });

  it('reports found items, imports them once, then reports handled', async () => {
    seedLegacyFiles();

    const status = await authed(request(app).get(`/workspaces/${wsId}/legacy-import`));
    expect(status.status).toBe(200);
    expect(status.body as LegacyImportStatus).toMatchObject({
      workspaceId: wsId,
      found: ['settings', 'secrets'],
      handled: null,
    });

    const imported = await authed(request(app).post(`/workspaces/${wsId}/legacy-import`));
    expect(imported.status).toBe(200);
    expect(imported.body as LegacyImportResult).toEqual({ profiles: 1, providerKeys: 1, namedSecrets: 1 });

    // The values landed in the Studio home stores.
    const paths = studioPathsFor(studioHome);
    expect(new SettingsStore(paths).list().profiles.map((p) => p.id)).toContain('legacy-acme');
    expect(new SecretsStore(paths).getKey('openai')).toBe('sk-old-key');

    const after = await authed(request(app).get(`/workspaces/${wsId}/legacy-import`));
    expect((after.body as LegacyImportStatus).handled).toBe('imported');
  });

  it('409s LOUSHO_LEGACY_IMPORT_EMPTY when the folder has nothing to offer', async () => {
    const res = await authed(request(app).post(`/workspaces/${wsId}/legacy-import`));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'LOUSHO_LEGACY_IMPORT_EMPTY' });
  });

  it('skip marks the offer handled without copying', async () => {
    seedLegacyFiles();
    const res = await authed(request(app).post(`/workspaces/${wsId}/legacy-import/skip`));
    expect(res.status).toBe(204);
    const status = await authed(request(app).get(`/workspaces/${wsId}/legacy-import`));
    expect((status.body as LegacyImportStatus).handled).toBe('skipped');
    const paths = studioPathsFor(studioHome);
    expect(new SecretsStore(paths).getKey('openai')).toBeUndefined();
  });
});
