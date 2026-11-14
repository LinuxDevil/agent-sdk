/**
 * W11c: `GET /workspaces/:ws/host` + `POST /workspaces/:ws/host/restart`
 * over real `createWorkspaceContext`s whose `WorkspaceHostSelector`s are
 * driven by W11a's `fakeBridge.mjs` installed as each workspace's SDK.
 * The `selectHost` services seam injects short client timeouts and
 * per-workspace `FAKE_BRIDGE_*` env; `process.env` propagation covers the
 * rest (bridgeEnv spreads it).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import request from 'supertest';
import type { StudioEvent } from '../../shared/wireTypes';
import type { WorkspaceRef } from '../../shared/workspace';
import { createApp } from '../app';
import { createWorkspaceContext, type WorkspaceContext, type WorkspaceResolver, type WorkspaceServices } from '../workspace/context';
import { WorkspaceHostSelector } from '../host/hostSelector';
import { WorkspaceRegistry } from '../workspace/workspaceRegistry';
import { SecretsStore } from '../secretsStore';
import { SettingsStore } from '../settingsStore';
import { SpendLog } from '../passes/spendLog';
import { AlertStore } from '../inbox/alertStore';
import { PassRunner } from '../passes/passRunner';

const FAKE_BRIDGE = fileURLToPath(new URL('../host/__tests__/fakeBridge.mjs', import.meta.url));

/** A workspace whose node_modules SDK's `bin/lousho.js` IS the fake bridge. */
function sdkWorkspace(root: string): void {
  const pkgDir = path.join(root, 'node_modules', '@lousho', 'build-ai-agent');
  fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(pkgDir, 'dist', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@lousho/build-ai-agent', version: '9.9.9-test' }));
  fs.copyFileSync(FAKE_BRIDGE, path.join(pkgDir, 'bin', 'lousho.js'));
  fs.writeFileSync(path.join(pkgDir, 'dist', 'cli', 'bridge.mjs'), '// built\n');
}

describe('host routes (W11c)', () => {
  let dir: string;
  let studioDir: string;
  let registry: WorkspaceRegistry;
  let services: WorkspaceServices;
  /** root -> extra env for that workspace's bridge child. */
  let envByRoot: Map<string, Record<string, string>>;
  let contexts: WorkspaceContext[];
  let app: Express;
  let launch: WorkspaceContext;
  let inProcessCtx: WorkspaceContext;
  let bridgeCtx: WorkspaceContext;
  let readOnlyCtx: WorkspaceContext;
  let failedCtx: WorkspaceContext;
  let gateFile: string;

  async function ctxFor(root: string): Promise<WorkspaceContext> {
    const ref: WorkspaceRef = await registry.ensure(root);
    const ctx = createWorkspaceContext(ref, services);
    contexts.push(ctx);
    return ctx;
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w11c-host-'));
    studioDir = path.join(dir, 'studio');
    fs.mkdirSync(studioDir, { recursive: true });
    const secretsStore = new SecretsStore(studioDir);
    const settingsStore = new SettingsStore(studioDir);
    const spendLog = new SpendLog(path.join(studioDir, 'spend.jsonl'));
    const alerts = new AlertStore(path.join(studioDir, 'alerts.json'));
    registry = new WorkspaceRegistry(path.join(studioDir, 'workspaces.json'));
    envByRoot = new Map();
    contexts = [];
    services = {
      secretsStore,
      settingsStore,
      observe: false,
      passRunner: new PassRunner({ baseDir: studioDir, spendLog, isEnabled: () => false }),
      spendLog,
      alerts,
      collector: { url: () => 'http://127.0.0.1:9', token: () => undefined },
      studioVersion: '9.9.9-studio',
      selectHost: (ref, deps) =>
        new WorkspaceHostSelector(ref, {
          ...deps,
          clientOptions: { stderr: () => undefined, timeouts: { hello: 400, shutdown: 200 } },
          extraEnv: envByRoot.get(ref.root),
        }),
    };

    const roots = {
      inProcess: path.join(dir, 'plain'),
      bridge: path.join(dir, 'sdk-ok'),
      readOnly: path.join(dir, 'sdk-old'),
      failed: path.join(dir, 'sdk-gate'),
    };
    for (const root of Object.values(roots)) fs.mkdirSync(root, { recursive: true });
    sdkWorkspace(roots.bridge);
    sdkWorkspace(roots.readOnly);
    sdkWorkspace(roots.failed);
    envByRoot.set(roots.readOnly, { FAKE_BRIDGE_SPEC_VERSIONS: '[1]' });
    gateFile = path.join(dir, 'gate');
    envByRoot.set(roots.failed, { FAKE_BRIDGE_SILENT_UNTIL: gateFile });

    inProcessCtx = await ctxFor(roots.inProcess);
    bridgeCtx = await ctxFor(roots.bridge);
    readOnlyCtx = await ctxFor(roots.readOnly);
    failedCtx = await ctxFor(roots.failed);
    launch = inProcessCtx;

    const byId = new Map(contexts.map((c) => [c.ref.id, c]));
    const resolver: WorkspaceResolver = {
      resolve: async (id) => byId.get(id ?? launch.ref.id),
      defaultId: () => launch.ref.id,
      retain: () => () => undefined,
    };
    app = createApp({
      workspace: launch,
      workspaces: resolver,
      baseDir: roots.inProcess,
      studioHome: studioDir,
      secretsStore,
      settingsStore,
      spendLog,
      passRunner: services.passRunner,
      alerts,
    });
  });

  afterEach(async () => {
    await Promise.all(contexts.map((c) => c.dispose().catch(() => undefined)));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const get = (ws: string) => request(app).get(`/workspaces/${ws}/host`);
  const post = (ws: string) => request(app).post(`/workspaces/${ws}/host/restart`);

  it('GET on an in-process workspace reports the info banner and ready state', async () => {
    const res = await get(inProcessCtx.ref.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      workspaceId: inProcessCtx.ref.id,
      mode: 'in-process',
      state: 'ready',
      sdkVersion: '9.9.9-studio',
      studioSdkVersion: expect.any(String),
    });
    expect(res.body.banner).toMatchObject({ tone: 'info' });
    expect(res.body.banner.text).toContain('no @lousho/build-ai-agent');
    expect(res.body.recentStderr).toBeUndefined();
  });

  it('GET on a bridge workspace reports bridge/ready with the hello sdkVersion', async () => {
    const res = await get(bridgeCtx.ref.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      workspaceId: bridgeCtx.ref.id,
      mode: 'bridge',
      state: 'ready',
      sdkVersion: '0.0.0-fake',
      studioSdkVersion: expect.any(String),
      banner: null,
    });
  });

  it('GET on a read-only workspace reports the update warning', async () => {
    const res = await get(readOnlyCtx.ref.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ workspaceId: readOnlyCtx.ref.id, mode: 'read-only', state: 'ready' });
    expect(res.body.banner).toMatchObject({ tone: 'warning' });
    expect(res.body.banner.text).toContain('@lousho/build-ai-agent');
  });

  it('GET on a crashed bridge reports failed with the restart banner and stderr', async () => {
    const res = await get(failedCtx.ref.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      workspaceId: failedCtx.ref.id,
      mode: 'bridge',
      state: 'failed',
      banner: { tone: 'danger', action: 'restart' },
    });
    expect(res.body.recentStderr).toEqual(
      expect.arrayContaining([expect.stringContaining('silent until the gate file')])
    );
  });

  it('GET answers 404 for an unknown workspace and 400 for a malformed id', async () => {
    const missing = await get('unknown-000001');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('LOUSHO_WORKSPACE_NOT_FOUND');
    const bad = await get('not a workspace!');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('LOUSHO_WORKSPACE_ID_INVALID');
  });

  it('POST restart on an in-process workspace is a 409 LOUSHO_HOST_NOT_BRIDGE', async () => {
    const res = await post(inProcessCtx.ref.id);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Only a project bridge can be restarted.', code: 'LOUSHO_HOST_NOT_BRIDGE' });
  });

  it('POST restart on a read-only workspace re-runs the handshake (still read-only)', async () => {
    const res = await post(readOnlyCtx.ref.id);
    expect(res.status).toBe(202);
    expect(res.body.mode).toBe('read-only');
  });

  it('a read-only workspace reads agents but refuses writes and runs', async () => {
    const ws = { 'x-lousho-workspace': readOnlyCtx.ref.id };
    const list = await request(app).get('/agents').set(ws);
    expect(list.status).toBe(200);
    const save = await request(app).put('/agents/some-agent').set(ws).send({ spec: { version: 2 } });
    expect(save.status).toBe(409);
    expect(save.body.code).toBe('LOUSHO_WORKSPACE_READ_ONLY');
    const run = await request(app).post('/agents/some-agent/run').set(ws).send({});
    expect(run.status).toBe(409);
    expect(run.body.code).toBe('LOUSHO_WORKSPACE_READ_ONLY');
    // Studio-global routes are never gated.
    const catalog = await request(app).get('/catalog/tools').set(ws);
    expect(catalog.status).toBe(200);
  });

  it('POST restart revives a crashed bridge and publishes host.status events', async () => {
    const events: StudioEvent[] = [];
    const off = failedCtx.events.subscribe((e) => events.push(e));
    try {
      // The gate file flips the fake bridge from silent to answering hello.
      fs.writeFileSync(gateFile, 'go');
      const res = await post(failedCtx.ref.id);
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ mode: 'bridge', state: 'ready', banner: null, sdkVersion: '0.0.0-fake' });
      const statuses = events.filter((e) => e.type === 'host.status');
      expect(statuses.length).toBeGreaterThan(0);
      expect(statuses.at(-1)).toMatchObject({
        type: 'host.status',
        payload: { workspaceId: failedCtx.ref.id, mode: 'bridge', state: 'ready', banner: null },
      });
    } finally {
      off();
    }
  });

  it('a settling handshake publishes host.status on the workspace bus', async () => {
    // A fresh bridge context: subscribe before its handshake settles.
    const lateRoot = path.join(dir, 'sdk-late');
    fs.mkdirSync(lateRoot, { recursive: true });
    sdkWorkspace(lateRoot);
    const events: StudioEvent[] = [];
    const ctx = await ctxFor(lateRoot);
    const off = ctx.events.subscribe((e) => events.push(e));
    try {
      await ctx.hostSelector.ready();
      // Selection settle AND the client's ready transition each publish once.
      const statuses = events.filter((e) => e.type === 'host.status');
      expect(statuses.length).toBeGreaterThanOrEqual(1);
      expect(statuses.at(-1)).toMatchObject({
        type: 'host.status',
        payload: { workspaceId: ctx.ref.id, mode: 'bridge', state: 'ready', banner: null },
      });
    } finally {
      off();
    }
  });
});
