import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { VERSION, type AgentSpecV2 } from 'lousho';
import { createApp } from '../app';
import type { Express } from 'express';
import { createWorkspaceContext, type WorkspaceContext, type WorkspaceServices } from '../workspace/context';
import { WorkspaceManager } from '../workspace/workspaceManager';
import { WorkspaceRegistry } from '../workspace/workspaceRegistry';
import type { WorkspaceRef } from '../../shared/workspace';
import { AgentRepo } from '../storage/agentRepo';
import { SecretsStore } from '../secretsStore';
import { SettingsStore } from '../settingsStore';
import { SpendLog } from '../passes/spendLog';
import { AlertStore } from '../inbox/alertStore';
import { PassRunner } from '../passes/passRunner';

/**
 * W06a end to end: `GET /agents?ws=all` (or `x-lousho-workspace: all`)
 * answers the cross-workspace aggregate - every registered workspace's
 * agent list items tagged `workspaceId`, cold workspaces read through a
 * bare AgentRepo (never warmed), and missing folders land in `skipped`.
 */

function v2Spec(name: string): AgentSpecV2 {
  return { version: 2, name, model: 'mock/mock-1', instructions: `You are ${name}.` };
}

const TOKEN = 'e2e-studio-token';
const AUTH = { 'x-lousho-studio-token': TOKEN };

function authed(req: request.Test) {
  return req.set(AUTH);
}

describe('GET /agents?ws=all (cross-workspace aggregate)', () => {
  let dir: string;
  let launchDir: string;
  let otherDir: string;
  let goneDir: string;
  let registry: WorkspaceRegistry;
  let launchRef: WorkspaceRef;
  let otherRef: WorkspaceRef;
  let goneRef: WorkspaceRef;
  let services: WorkspaceServices;

  function wire(warm?: () => WorkspaceContext[]): {
    app: Express;
    manager: WorkspaceManager;
    launch: WorkspaceContext;
  } {
    const launch = createWorkspaceContext(launchRef, services);
    const manager = new WorkspaceManager({
      registry,
      launch,
      build: (ref) => createWorkspaceContext(ref, services),
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
      sweepMs: 0,
    });
    const app = createApp({
      workspace: launch,
      workspaces: manager,
      workspaceRegistry: registry,
      warm: warm ?? (() => manager.warm()),
      baseDir: launchDir,
      studioHome: path.join(dir, 'studio-home'),
      secretsStore: services.secretsStore,
      settingsStore: services.settingsStore,
      spendLog: services.spendLog,
      passRunner: services.passRunner,
      alerts: services.alerts,
      access: { token: TOKEN },
    });
    return { app, manager, launch };
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w06a-all-'));
    launchDir = path.join(dir, 'launch');
    otherDir = path.join(dir, 'other');
    goneDir = path.join(dir, 'gone');
    for (const root of [launchDir, otherDir, goneDir]) fs.mkdirSync(root, { recursive: true });
    const studioDir = path.join(dir, 'studio');
    fs.mkdirSync(studioDir, { recursive: true });
    const secretsStore = new SecretsStore(studioDir);
    const settingsStore = new SettingsStore(studioDir);
    const spendLog = new SpendLog(path.join(studioDir, 'spend.jsonl'));
    const alerts = new AlertStore(path.join(studioDir, 'alerts.json'));
    services = {
      secretsStore,
      settingsStore,
      observe: false,
      passRunner: new PassRunner({ baseDir: studioDir, spendLog, isEnabled: () => false }),
      spendLog,
      alerts,
      collector: () => ({ url: 'http://127.0.0.1:1' }),
      studioVersion: VERSION,
    };
    registry = new WorkspaceRegistry(path.join(studioDir, 'workspaces.json'));
    launchRef = await registry.ensure(launchDir);
    otherRef = await registry.ensure(otherDir);
    goneRef = await registry.ensure(goneDir);
    // Agents: launch has one, other has two.
    const launchRepo = new AgentRepo(launchDir);
    const otherRepo = new AgentRepo(otherDir);
    await launchRepo.writeSpec('zeta', v2Spec('zeta'));
    await otherRepo.writeSpec('alpha', v2Spec('alpha'));
    await otherRepo.writeSpec('beta', v2Spec('beta'));
    // The gone workspace is registered, then its folder is deleted.
    fs.rmSync(goneDir, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists every workspace\'s agents tagged with workspaceId; the missing folder lands in skipped', async () => {
    const { app } = wire();
    const res = await authed(request(app).get('/agents').query({ ws: 'all' }));
    expect(res.status).toBe(200);
    const items = res.body.items as { id: string; workspaceId: string; kind: string }[];
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.kind).toBe('workspace');
      expect([launchRef.id, otherRef.id]).toContain(item.workspaceId);
    }
    const idsOf = (id: string) => items.filter((i) => i.workspaceId === id).map((i) => i.id).sort();
    expect(idsOf(otherRef.id)).toEqual(['alpha', 'beta']);
    expect(idsOf(launchRef.id)).toEqual(['zeta']);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].workspaceId).toBe(goneRef.id);
    expect(res.body.skipped[0].reason).toMatch(/folder/i);
  });

  it('sorts by workspace name, then agent name, then agent id', async () => {
    const { app } = wire();
    const res = await authed(request(app).get('/agents').query({ ws: 'all' }));
    const items = res.body.items as { workspaceId: string; name: string; id: string }[];
    // 'gone' < 'launch' < 'other' alphabetically, but gone is skipped -
    // so launch's zeta must precede other's alpha/beta.
    expect(items.map((i) => `${i.workspaceId}:${i.id}`)).toEqual([
      `${launchRef.id}:zeta`,
      `${otherRef.id}:alpha`,
      `${otherRef.id}:beta`,
    ]);
  });

  it('accepts the x-lousho-workspace: all header form', async () => {
    const { app } = wire();
    const res = await authed(request(app).get('/agents').set('x-lousho-workspace', 'all'));
    expect(res.status).toBe(200);
    expect((res.body.items as unknown[]).length).toBe(3);
  });

  it('answers 400 for ?view=legacy with ws=all', async () => {
    const { app } = wire();
    const res = await authed(request(app).get('/agents').query({ ws: 'all', view: 'legacy' }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'The legacy view lists one workspace only.', code: 'LOUSHO_BODY_INVALID' });
  });

  it('requires the token before serving the aggregate', async () => {
    const { app } = wire();
    const res = await request(app).get('/agents').query({ ws: 'all' });
    expect(res.status).toBe(401);
  });

  it('reads a cold workspace through a bare AgentRepo - never warms it', async () => {
    const { app, manager } = wire();
    const res = await authed(request(app).get('/agents').query({ ws: 'all' }));
    expect(res.status).toBe(200);
    // `other` was never warmed: after the aggregate read only the launch
    // context is warm.
    expect(manager.warm().map((c) => c.ref.id)).toEqual([launchRef.id]);
    const otherItems = (res.body.items as { workspaceId: string }[]).filter((i) => i.workspaceId === otherRef.id);
    expect(otherItems).toHaveLength(2);
  });

  it('a warm workspace reports live run status through runStatus; cold ones read persisted traces', async () => {
    const { app, manager, launch } = wire();
    // Warm `other` via the resolver, then fake a live run on the launch
    // context so its lastRun is not the persisted-trace fallback.
    await authed(request(app).get('/agents').set('x-lousho-workspace', otherRef.id));
    expect(manager.warm().map((c) => c.ref.id)).toContain(otherRef.id);
    const statusSpy = vi.spyOn(launch.runs, 'status').mockReturnValue({
      agentId: 'zeta',
      status: 'running',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    const res = await authed(request(app).get('/agents').query({ ws: 'all' }));
    expect(res.status).toBe(200);
    const items = res.body.items as { workspaceId: string; id: string; lastRun?: { status?: string } }[];
    const zeta = items.find((i) => i.id === 'zeta');
    expect(zeta?.lastRun?.status).toBe('running');
    // Cold `other` agents still list - their lastRun comes from traces
    // (none exist, so the field is simply absent).
    const cold = items.filter((i) => i.workspaceId === otherRef.id);
    expect(cold).toHaveLength(2);
    expect(statusSpy).toHaveBeenCalled();
  });

  it('ordinary GET /agents is unchanged by the aggregate route', async () => {
    const { app } = wire();
    const res = await authed(request(app).get('/agents').set('x-lousho-workspace', otherRef.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const ids = (res.body as { id: string }[]).map((e) => e.id).sort();
    expect(ids).toEqual(['alpha', 'beta']);
  });
});

describe('GET /agents?ws=all - observed agents (W07a)', () => {
  let dir: string;
  let launchDir: string;
  let otherDir: string;
  let registry: WorkspaceRegistry;
  let launchRef: WorkspaceRef;
  let otherRef: WorkspaceRef;
  let services: WorkspaceServices;
  let daemon: http.Server | undefined;
  let daemonUrl: string;
  const ENV_URL = 'LOUSHO_OBSERVE_URL';
  let savedUrl: string | undefined;

  const daemonRow = (over: Record<string, unknown>) => ({
    agent_id: 'r1',
    project: null,
    name: 'agent',
    version: '1.0.0',
    first_seen: 1000,
    last_heartbeat: 2000,
    status: 'healthy',
    hostname: 'h1',
    pid: 1,
    runs_today: 0,
    error_rate_today: 0,
    ...over,
  });

  async function startDaemon(rows: unknown[] | 'hang'): Promise<void> {
    daemon = http.createServer((_req, res) => {
      if (rows === 'hang') return; // never answers -> the 3 s timeout path is covered by unit tests; here just close
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ agents: rows }));
    });
    await new Promise<void>((resolve) => daemon!.listen(0, '127.0.0.1', resolve));
    daemonUrl = `http://127.0.0.1:${(daemon!.address() as { port: number }).port}`;
  }

  function wire(): Express {
    const launch = createWorkspaceContext(launchRef, services);
    const manager = new WorkspaceManager({
      registry,
      launch,
      build: (ref) => createWorkspaceContext(ref, services),
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
      sweepMs: 0,
    });
    return createApp({
      workspace: launch,
      workspaces: manager,
      workspaceRegistry: registry,
      warm: () => manager.warm(),
      baseDir: launchDir,
      studioHome: path.join(dir, 'studio-home'),
      secretsStore: services.secretsStore,
      settingsStore: services.settingsStore,
      spendLog: services.spendLog,
      passRunner: services.passRunner,
      alerts: services.alerts,
      access: { token: TOKEN },
    });
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w07a-all-'));
    launchDir = path.join(dir, 'launch');
    otherDir = path.join(dir, 'other');
    for (const root of [launchDir, otherDir]) fs.mkdirSync(root, { recursive: true });
    const studioDir = path.join(dir, 'studio');
    fs.mkdirSync(studioDir, { recursive: true });
    const secretsStore = new SecretsStore(studioDir);
    const settingsStore = new SettingsStore(studioDir);
    const spendLog = new SpendLog(path.join(studioDir, 'spend.jsonl'));
    const alerts = new AlertStore(path.join(studioDir, 'alerts.json'));
    services = {
      secretsStore,
      settingsStore,
      observe: false,
      passRunner: new PassRunner({ baseDir: studioDir, spendLog, isEnabled: () => false }),
      spendLog,
      alerts,
      collector: () => ({ url: 'http://127.0.0.1:1' }),
      studioVersion: VERSION,
    };
    registry = new WorkspaceRegistry(path.join(studioDir, 'workspaces.json'));
    launchRef = await registry.ensure(launchDir);
    otherRef = await registry.ensure(otherDir);
    const launchRepo = new AgentRepo(launchDir);
    const otherRepo = new AgentRepo(otherDir);
    await launchRepo.writeSpec('zeta', v2Spec('zeta'));
    await otherRepo.writeSpec('alpha', v2Spec('alpha'));
    await otherRepo.writeSpec('beta', v2Spec('beta'));
    savedUrl = process.env[ENV_URL];
  });

  afterEach(async () => {
    if (savedUrl === undefined) delete process.env[ENV_URL];
    else process.env[ENV_URL] = savedUrl;
    if (daemon) await new Promise((resolve) => daemon!.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('merges daemon rows: grouped under the matching workspace, the rest under Elsewhere; Studio rows dropped', async () => {
    // `other` reports project = its workspace id (LOUSHO_OBSERVE_PROJECT=<id> case).
    await startDaemon([
      daemonRow({ agent_id: 'w1', name: 'billing-worker', project: otherRef.id, status: 'healthy' }),
      daemonRow({ agent_id: 'w2', name: 'billing-worker', project: otherRef.id, status: 'stale', hostname: 'h2' }),
      daemonRow({ agent_id: 'n1', name: 'nightly', project: 'ci' }),
      daemonRow({ agent_id: 's1', name: 'alpha', project: otherRef.id }), // other's own agent id -> dropped
      daemonRow({ agent_id: 'p1', name: 'playground', project: otherRef.id }), // never appears
      daemonRow({ agent_id: 'e1', name: 'alpha-evals', project: otherRef.id }), // -evals of own agent -> dropped
    ]);
    process.env[ENV_URL] = daemonUrl;
    const res = await authed(request(wire()).get('/agents').query({ ws: 'all' }));
    expect(res.status).toBe(200);
    expect(res.body.observed).toBe('ok');
    const observed = (res.body.items as { kind: string; name?: string; workspaceId?: string | null; instances?: number; status?: string }[]).filter(
      (i) => i.kind === 'observed'
    );
    expect(observed).toHaveLength(2);
    const worker = observed.find((i) => i.name === 'billing-worker')!;
    expect(worker.workspaceId).toBe(otherRef.id);
    expect(worker.instances).toBe(2);
    expect(worker.status).toBe('healthy');
    const nightly = observed.find((i) => i.name === 'nightly')!;
    expect(nightly.workspaceId).toBeNull();
    // Workspace items still all present and first.
    const workspaceItems = (res.body.items as { kind: string }[]).filter((i) => i.kind === 'workspace');
    expect(workspaceItems).toHaveLength(3);
  });

  it('daemon down -> 200 with workspace items and observed: unavailable', async () => {
    process.env[ENV_URL] = 'http://127.0.0.1:1'; // closed port
    const res = await authed(request(wire()).get('/agents').query({ ws: 'all' }));
    expect(res.status).toBe(200);
    expect(res.body.observed).toBe('unavailable');
    expect((res.body.items as { kind: string }[]).every((i) => i.kind === 'workspace')).toBe(true);
  });
});
