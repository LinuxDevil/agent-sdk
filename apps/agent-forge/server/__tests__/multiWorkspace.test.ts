import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { AgentSpec, AgentSpecV2 } from 'lousho';
import { createApp } from '../app';
import type { Express } from 'express';
import { createWorkspaceContext, type WorkspaceContext, type WorkspaceServices } from '../workspace/context';
import { WorkspaceManager } from '../workspace/workspaceManager';
import { WorkspaceRegistry } from '../workspace/workspaceRegistry';
import type { WorkspaceRef } from '../../shared/workspace';
import { SecretsStore } from '../secretsStore';
import { SettingsStore } from '../settingsStore';
import { SpendLog } from '../passes/spendLog';
import { AlertStore } from '../inbox/alertStore';
import { PassRunner } from '../passes/passRunner';
import { deferred, resetSteerGate, setSteerGateScript, steerGateProviders } from './steerGate';

/**
 * W02a end to end: `createApp` wired to a real `WorkspaceManager` over a
 * real `WorkspaceRegistry` and real `createWorkspaceContext`s (observe
 * off, passes disabled). Pins the acceptance criteria that need HTTP:
 * header/query selection, lazy single build, 404s, the warm cap, idle
 * dispose with an active-run keep, DELETE disposal and per-workspace run
 * isolation.
 */

const SPEC: AgentSpec = {
  name: 'stub-agent',
  prompt: 'You are a stub.',
  provider: { type: 'mock', model: 'mock-1' },
};

/** A v2 spec on the gated 'steergate' provider - its model call parks until the test releases the gate, so the run stays 'running'. */
const STEER_SPEC: AgentSpecV2 = {
  version: 2,
  name: 'support-bot',
  model: 'steergate/steer-1',
  instructions: 'You are a test agent.',
};

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function agentFile(root: string, id: string): string {
  return path.join(root, '.lousho', 'agents', `${id}.yaml`);
}

describe('multi-workspace Studio (WorkspaceManager over HTTP)', () => {
  let dir: string;
  let tick: number;
  let launchDir: string;
  let otherDir: string;
  let thirdDir: string;
  let registry: WorkspaceRegistry;
  let launchRef: WorkspaceRef;
  let otherRef: WorkspaceRef;
  let thirdRef: WorkspaceRef;
  let services: WorkspaceServices;
  let disposeSpies: Map<string, Mock<[], Promise<void>>>;
  let buildCounts: Map<string, number>;

  function spyDispose(ctx: WorkspaceContext): void {
    const spy = vi.fn<[], Promise<void>>(ctx.dispose.bind(ctx));
    ctx.dispose = spy;
    disposeSpies.set(ctx.ref.id, spy);
  }

  /** The real wiring index.ts performs, with test knobs on the manager. */
  function wire(options: { maxWarm?: number; idleMs?: number } = {}): {
    app: Express;
    manager: WorkspaceManager;
    launch: WorkspaceContext;
  } {
    const launch = createWorkspaceContext(launchRef, services);
    spyDispose(launch);
    const manager = new WorkspaceManager({
      registry,
      launch,
      build: (ref) => {
        buildCounts.set(ref.id, (buildCounts.get(ref.id) ?? 0) + 1);
        const ctx = createWorkspaceContext(ref, services);
        spyDispose(ctx);
        return ctx;
      },
      now: () => tick,
      sweepMs: 0, // no timer: tests call manager.sweep() themselves
      ...options,
    });
    const app = createApp({
      workspace: launch,
      workspaces: manager,
      workspaceRegistry: registry,
      baseDir: launchDir,
      studioHome: path.join(dir, 'studio-home'),
      secretsStore: services.secretsStore,
      settingsStore: services.settingsStore,
      spendLog: services.spendLog,
      passRunner: services.passRunner,
      alerts: services.alerts,
    });
    return { app, manager, launch };
  }

  beforeEach(async () => {
    resetSteerGate();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w02a-mw-'));
    tick = Date.parse('2026-01-01T00:00:00.000Z');
    launchDir = path.join(dir, 'launch');
    otherDir = path.join(dir, 'other');
    thirdDir = path.join(dir, 'third');
    for (const root of [launchDir, otherDir, thirdDir]) fs.mkdirSync(root, { recursive: true });
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
      collector: () => ({ url: 'http://127.0.0.1:7777' }),
      studioVersion: 'test',
    };
    registry = new WorkspaceRegistry(path.join(studioDir, 'workspaces.json'));
    launchRef = await registry.ensure(launchDir);
    otherRef = await registry.ensure(otherDir);
    thirdRef = await registry.ensure(thirdDir);
    disposeSpies = new Map();
    buildCounts = new Map();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('header and ?ws= select the workspace; PUT writes that folder, never the launch one', async () => {
    const { app } = wire();

    // B's agent, addressed by header.
    const putB = await request(app)
      .put('/agents/only-b')
      .set('x-lousho-workspace', otherRef.id)
      .send(SPEC);
    expect(putB.status).toBe(204);
    expect(fs.existsSync(agentFile(otherDir, 'only-b'))).toBe(true);
    expect(fs.existsSync(agentFile(launchDir, 'only-b'))).toBe(false);

    // A's agent, no id at all -> the launch workspace.
    const putA = await request(app).put('/agents/only-a').send(SPEC);
    expect(putA.status).toBe(204);
    expect(fs.existsSync(agentFile(launchDir, 'only-a'))).toBe(true);

    // The same agent addressed by ?ws= lands in B too.
    const putB2 = await request(app).put('/agents/only-b2?ws=' + otherRef.id).send(SPEC);
    expect(putB2.status).toBe(204);
    expect(fs.existsSync(agentFile(otherDir, 'only-b2'))).toBe(true);

    const listB = await request(app).get('/agents').set('x-lousho-workspace', otherRef.id);
    expect(listB.status).toBe(200);
    const idsB = listB.body.map((e: { id: string }) => e.id);
    expect(idsB).toContain('only-b');
    expect(idsB).toContain('only-b2');
    expect(idsB).not.toContain('only-a');

    const listA = await request(app).get('/agents');
    const idsA = listA.body.map((e: { id: string }) => e.id);
    expect(idsA).toContain('only-a');
    expect(idsA).not.toContain('only-b');
  });

  it('two parallel first requests for one workspace share a single build', async () => {
    const { app } = wire();
    const [a, b] = await Promise.all([
      request(app).get('/agents').set('x-lousho-workspace', otherRef.id),
      request(app).get('/agents').query({ ws: otherRef.id }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(buildCounts.get(otherRef.id)).toBe(1);
    // A warm hit builds nothing more.
    await request(app).get('/agents').set('x-lousho-workspace', otherRef.id);
    expect(buildCounts.get(otherRef.id)).toBe(1);
  });

  it('an unknown id and a registered id whose folder vanished are both 404', async () => {
    const { app } = wire();
    const unknown = await request(app).get('/agents').set('x-lousho-workspace', 'ghost-abc123');
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('LOUSHO_WORKSPACE_NOT_FOUND');

    fs.rmSync(thirdDir, { recursive: true, force: true });
    const gone = await request(app).get('/agents').set('x-lousho-workspace', thirdRef.id);
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe('LOUSHO_WORKSPACE_NOT_FOUND');
  });

  it('with maxWarm 2, touching launch, B and C disposes B (LRU) and keeps the launch context', async () => {
    const { app, manager } = wire({ maxWarm: 2 });
    await request(app).get('/agents'); // touch launch
    await request(app).get('/agents').set('x-lousho-workspace', otherRef.id);
    tick += 1000;
    await request(app).get('/agents').set('x-lousho-workspace', thirdRef.id);

    // Warm set is capped at 2 (launch + most recent): B was evicted.
    const warmIds = manager.warm().map((ctx) => ctx.ref.id);
    expect(warmIds).toEqual([launchRef.id, thirdRef.id]);
    await vi.waitFor(() => expect(disposeSpies.get(otherRef.id)).toHaveBeenCalled());

    // B is still registered: the next request rebuilds it (and evicts C).
    await request(app).get('/agents').set('x-lousho-workspace', otherRef.id);
    expect(buildCounts.get(otherRef.id)).toBe(2);
    expect(manager.warm().map((ctx) => ctx.ref.id)).toEqual([launchRef.id, otherRef.id]);
  });

  it('an idle context disposes on sweep; one with a run in flight survives until the run settles', async () => {
    const { app, manager } = wire({ idleMs: 1000 });
    // Warm B, then let it go idle past idleMs.
    await request(app).get('/agents').set('x-lousho-workspace', otherRef.id);
    tick += 2000;
    await manager.sweep();
    expect(disposeSpies.get(otherRef.id)).toHaveBeenCalled();
    expect(manager.warm().map((ctx) => ctx.ref.id)).not.toContain(otherRef.id);

    // C goes idle too, but a steergate run keeps it warm.
    await request(app).get('/agents').set('x-lousho-workspace', thirdRef.id);
    const gate = deferred();
    setSteerGateScript({ blockCalls: 1, mode: 'before-output', gate: gate.promise });
    const run = await request(app)
      .post('/agents/support-bot/run')
      .set('x-lousho-workspace', thirdRef.id)
      .send({ input: 'hi', spec: STEER_SPEC });
    expect(run.status).toBe(202);
    const thirdCtx = manager.warm().find((ctx) => ctx.ref.id === thirdRef.id)!;
    await waitFor(() => thirdCtx.runs.status('support-bot').status === 'running', 'C run to be running');

    tick += 60_000;
    await manager.sweep();
    expect(disposeSpies.get(thirdRef.id)).not.toHaveBeenCalled();
    expect(manager.warm().map((ctx) => ctx.ref.id)).toContain(thirdRef.id);

    // Once the run settles the next sweep disposes it.
    gate.resolve();
    await waitFor(() => thirdCtx.runs.status('support-bot').status === 'done', 'C run to finish', 10000);
    await manager.sweep();
    expect(disposeSpies.get(thirdRef.id)).toHaveBeenCalled();
  });

  it('DELETE /workspaces/:id removes the entry and disposes its warm context', async () => {
    const { app, manager } = wire();
    await request(app).get('/agents').set('x-lousho-workspace', otherRef.id);
    expect(disposeSpies.get(otherRef.id)).not.toHaveBeenCalled();

    const del = await request(app).delete(`/workspaces/${otherRef.id}`);
    expect(del.status).toBe(204);
    expect(disposeSpies.get(otherRef.id)).toHaveBeenCalled();
    expect(manager.warm().map((ctx) => ctx.ref.id)).not.toContain(otherRef.id);

    // The id no longer resolves: 404, and the folder on disk is untouched.
    const after = await request(app).get('/agents').set('x-lousho-workspace', otherRef.id);
    expect(after.status).toBe(404);
    expect(fs.existsSync(otherDir)).toBe(true);
  });

  it('two workspaces running the same agent id keep independent run status', async () => {
    const { app } = wire();
    const gateA = deferred();
    const gateB = deferred();
    setSteerGateScript({ blockCalls: 1, mode: 'before-output', gate: gateA.promise });
    const runA = await request(app)
      .post('/agents/support-bot/run')
      .set('x-lousho-workspace', launchRef.id)
      .send({ input: 'hi', spec: STEER_SPEC });
    expect(runA.status).toBe(202);
    // A's provider consumed the first gate script (the registry may build
    // more than one steergate provider - catalog probes included - so wait
    // for a provider with a parked call, not a count of one). Arm the
    // second script only now so B's run can't steal it.
    await waitFor(() => steerGateProviders.some((p) => p.calls.length === 1), 'A first model call');
    setSteerGateScript({ blockCalls: 1, mode: 'before-output', gate: gateB.promise });
    const runB = await request(app)
      .post('/agents/support-bot/run')
      .set('x-lousho-workspace', otherRef.id)
      .send({ input: 'hi', spec: STEER_SPEC });
    expect(runB.status).toBe(202);

    const statusA = () =>
      request(app).get('/agents/support-bot/status').set('x-lousho-workspace', launchRef.id);
    const statusB = () =>
      request(app).get('/agents/support-bot/status').set('x-lousho-workspace', otherRef.id);
    await waitFor(async () => (await statusA()).body.status === 'running', 'A run to be running');
    await waitFor(async () => (await statusB()).body.status === 'running', 'B run to be running');

    // Stopping B's run leaves A's untouched - separate RunManagers.
    const stopB = await request(app).post('/agents/support-bot/stop').set('x-lousho-workspace', otherRef.id);
    expect(stopB.status).toBe(202);
    await waitFor(async () => (await statusB()).body.status !== 'running', 'B run to stop');
    expect((await statusA()).body.status).toBe('running');

    gateA.resolve();
    gateB.resolve();
    // A finishes 'done'; B was stopped mid-run so it lands 'stopped'.
    const terminal = (s: string) => s === 'done' || s === 'stopped';
    await waitFor(async () => terminal((await statusA()).body.status), 'A run to finish', 10000);
    await waitFor(async () => terminal((await statusB()).body.status), 'B run to finish', 10000);
  });
});
