/**
 * W11c bridge-mode guards: features the bridge protocol does not carry
 * (flow runs, breakpoints, time travel) must refuse with
 * `LOUSHO_HOST_UNSUPPORTED` instead of silently using Studio's SDK.
 * The bridge side is a stub `AgentHost` (`kind: 'bridge'`) injected
 * through the `selectHost` services seam; the in-process control uses a
 * plain folder, which the real selector maps to Studio's own SDK.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Express } from 'express';
import request from 'supertest';
import { upgradeSpec, type AgentSpec } from 'lousho';
import { createApp } from '../app';
import {
  createWorkspaceContext,
  type WorkspaceContext,
  type WorkspaceResolver,
  type WorkspaceServices,
} from '../workspace/context';
import { WorkspaceHostSelector, type HostSelection, type SelectHostDeps } from '../host/hostSelector';
import type { AgentHost } from '../host/agentHost';
import { WorkspaceRegistry } from '../workspace/workspaceRegistry';
import { SecretsStore } from '../secretsStore';
import { SettingsStore } from '../settingsStore';
import { SpendLog } from '../passes/spendLog';
import { AlertStore } from '../inbox/alertStore';
import { PassRunner } from '../passes/passRunner';
import { WORKSPACE_HEADER } from '../../shared/workspace';

const BRIDGE_SELECTION: HostSelection = { mode: 'bridge', sdkVersion: '0.0.0-test', banner: null };

/** An AgentHost that reports `kind: 'bridge'` - enough for the guards, which never call it. */
function stubBridgeHost(): AgentHost {
  return {
    kind: 'bridge',
    sdkVersion: '0.0.0-test',
    start: vi.fn(async () => {
      throw new Error('stub bridge host: start is not expected in guard tests');
    }),
    steer: vi.fn(async () => ({ id: 's', applied: false as const })),
    abort: vi.fn(async () => undefined),
    resolveApproval: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    catalog: vi.fn(async () => ({ tools: [], models: [], guardrails: [], triggers: [] })),
    dispose: vi.fn(async () => undefined),
  };
}

/** A selector stand-in: bridge mode, no client, nothing ever settles further. */
function stubBridgeSelector(host: AgentHost): WorkspaceHostSelector {
  return {
    host,
    reportsToObserve: false,
    client: undefined,
    current: () => BRIDGE_SELECTION,
    ready: () => Promise.resolve(BRIDGE_SELECTION),
    restart: () => Promise.resolve(BRIDGE_SELECTION),
    onChange: () => () => undefined,
  } as unknown as WorkspaceHostSelector;
}

/** A minimal branching flow (v1 shape with step ids, upgraded) - abort.test.ts's fixture. */
function flowSpec(): ReturnType<typeof upgradeSpec> {
  return upgradeSpec({
    name: 'guard-flow-agent',
    prompt: 'classify this',
    provider: { type: 'mock', model: 'mock-1' },
    policy: {
      flow: {
        code: 'guard-flow-agent',
        name: 'guard-flow-agent',
        flow: {
          type: 'sequence',
          id: 'seq',
          steps: [
            { type: 'llmCall', id: 'llm', prompt: 'classify this', outputVariable: 'classify' },
            { type: 'end', id: 'end', value: 'done' },
          ],
        },
      },
    },
  } as unknown as AgentSpec);
}

describe('bridge-mode guards (W11c)', () => {
  let dir: string;
  let studioDir: string;
  let bridgeRoot: string;
  let plainRoot: string;
  let bridgeCtx: WorkspaceContext;
  let plainCtx: WorkspaceContext;
  let app: Express;

  const ws = (ctx: WorkspaceContext) => ({ [WORKSPACE_HEADER]: ctx.ref.id });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w11c-guards-'));
    studioDir = path.join(dir, 'studio');
    fs.mkdirSync(studioDir, { recursive: true });
    bridgeRoot = path.join(dir, 'bridge-ws');
    plainRoot = path.join(dir, 'plain-ws');
    fs.mkdirSync(bridgeRoot, { recursive: true });
    fs.mkdirSync(plainRoot, { recursive: true });

    const secretsStore = new SecretsStore(studioDir);
    const settingsStore = new SettingsStore(studioDir);
    const spendLog = new SpendLog(path.join(studioDir, 'spend.jsonl'));
    const alerts = new AlertStore(path.join(studioDir, 'alerts.json'));
    const passRunner = new PassRunner({ baseDir: studioDir, spendLog, isEnabled: () => false });
    const registry = new WorkspaceRegistry(path.join(studioDir, 'workspaces.json'));
    const services: WorkspaceServices = {
      secretsStore,
      settingsStore,
      observe: false,
      passRunner,
      spendLog,
      alerts,
      collector: { url: () => 'http://127.0.0.1:9', token: () => undefined },
      studioVersion: '9.9.9-studio',
      selectHost: (ref, deps: SelectHostDeps) =>
        ref.root === bridgeRoot ? stubBridgeSelector(stubBridgeHost()) : new WorkspaceHostSelector(ref, deps),
    };

    const mk = async (root: string) => createWorkspaceContext(await registry.ensure(root), services);
    plainCtx = await mk(plainRoot);
    bridgeCtx = await mk(bridgeRoot);

    const byId = new Map([plainCtx, bridgeCtx].map((c) => [c.ref.id, c]));
    const resolver: WorkspaceResolver = {
      resolve: async (id) => byId.get(id ?? plainCtx.ref.id),
      defaultId: () => plainCtx.ref.id,
      retain: () => () => undefined,
    };
    app = createApp({
      workspace: plainCtx,
      workspaces: resolver,
      baseDir: plainRoot,
      studioHome: studioDir,
      secretsStore,
      settingsStore,
      spendLog,
      passRunner,
      alerts,
    });
  });

  afterEach(async () => {
    await Promise.all([plainCtx.dispose(), bridgeCtx.dispose()].map((d) => d.catch(() => undefined)));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a flow run on a bridge workspace rejects LOUSHO_HOST_UNSUPPORTED', async () => {
    await expect(bridgeCtx.runs.run('guard-flow-agent', 'hi', flowSpec())).rejects.toMatchObject({
      code: 'LOUSHO_HOST_UNSUPPORTED',
    });
  });

  it('control: the same flow spec runs on an in-process workspace', async () => {
    await plainCtx.runs.run('guard-flow-agent', 'hi', flowSpec());
    const deadline = Date.now() + 10_000;
    let status = plainCtx.runs.status('guard-flow-agent');
    while (status.status !== 'done' && status.status !== 'error' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      status = plainCtx.runs.status('guard-flow-agent');
    }
    expect(status.status).toBe('done');
  });

  it('non-empty breakpoints on a bridge workspace 409; clearing stays allowed', async () => {
    const set = await request(app)
      .put('/agents/guard-flow-agent/debug/breakpoints')
      .set(ws(bridgeCtx))
      .send({ breakpoints: ['step-1'] });
    expect(set.status).toBe(409);
    expect(set.body.code).toBe('LOUSHO_HOST_UNSUPPORTED');

    const clear = await request(app)
      .put('/agents/guard-flow-agent/debug/breakpoints')
      .set(ws(bridgeCtx))
      .send({ breakpoints: [] });
    expect(clear.status).toBe(200);
  });

  it('control: breakpoints still set on an in-process workspace', async () => {
    const res = await request(app)
      .put('/agents/guard-flow-agent/debug/breakpoints')
      .set(ws(plainCtx))
      .send({ breakpoints: ['step-1'] });
    expect(res.status).toBe(200);
  });

  it('GET /runs/:id/history on a bridge workspace 409s LOUSHO_HOST_UNSUPPORTED', async () => {
    const res = await request(app).get('/runs/guard-flow-agent/history').set(ws(bridgeCtx));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LOUSHO_HOST_UNSUPPORTED');
  });

  it('control: history on an in-process workspace is not a host refusal', async () => {
    const res = await request(app).get('/runs/guard-flow-agent/history').set(ws(plainCtx));
    // No checkpoint exists for that run id - a 404, never a 409 host refusal.
    expect(res.status).toBe(404);
  });
});
