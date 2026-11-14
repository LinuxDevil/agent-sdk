/**
 * W11b: `BridgeAgentHost` - the `AgentHost` over `lousho bridge`.
 *
 * Unit half: a stub `BridgeClient` pins the request/push mapping,
 * secrets/env params, error translation and the read-only gate.
 * Integration half: a temp workspace whose `node_modules/lousho` is a
 * junction to this repo runs the REAL built bridge (`dist/cli/bridge.mjs`)
 * with the `scripted` provider preloaded.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AgentSpecV2, BridgePush, Message } from '@linuxdevil/lousho';
import { BridgeAgentHost, HostReadOnlyError, HostStartError } from '../host/bridgeAgentHost';
import { BridgeClient, BridgeError } from '../host/bridgeClient';
import { HostRunNotActiveError } from '../host/agentHost';
import type { HostCatalog, HostEvent, HostRunInput } from '../host/agentHost';
import type { HostSelection } from '../host/hostSelector';
import { findWorkspaceSdk, type WorkspaceSdk } from '../host/workspaceSdk';
import { SecretsStore } from '../secretsStore';

const SPEC: AgentSpecV2 = { version: 2, name: 'a', model: 'mock/m', instructions: 'Be brief.' };
const SDK: WorkspaceSdk = { version: '1.0.0', packageDir: '/sdk', binPath: '/sdk/bin/lousho.js', source: 'node_modules', built: true };
const BRIDGE_SELECTION: HostSelection = { mode: 'bridge', sdk: SDK, sdkVersion: '1.0.0', banner: null };
const READ_ONLY_SELECTION: HostSelection = {
  mode: 'read-only',
  sdk: SDK,
  sdkVersion: '1.0.0',
  banner: { tone: 'warning', text: 'read-only for tests' },
};
const FALLBACK: HostCatalog = { tools: [], models: [], guardrails: [], triggers: [] };

let dir: string;
let secretsDir: string;
let secretsStore: SecretsStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w11b-host-'));
  secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w11b-hsec-'));
  secretsStore = new SecretsStore(secretsDir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(secretsDir, { recursive: true, force: true });
});

// -- stub client -------------------------------------------------------------

interface Stub {
  client: BridgeClient;
  requests: Array<{ method: string; params: unknown }>;
  pushes: Map<string, (push: BridgePush) => void>;
  emit(runId: string, push: BridgePush): void;
  stop: Mock<[], Promise<void>>;
}

function stubClient(options: { hello?: { catalogHash: string; sdkVersion: string }; respond?: (method: string, params: unknown) => unknown; reject?: (method: string) => Error | undefined } = {}): Stub {
  const requests: Stub['requests'] = [];
  const pushes = new Map<string, (push: BridgePush) => void>();
  const stop = vi.fn<[], Promise<void>>(async () => undefined);
  const client = {
    hello: options.hello ?? { catalogHash: 'h1', sdkVersion: '1.0.0' },
    request: vi.fn(async (method: string, params: unknown) => {
      requests.push({ method, params });
      const failure = options.reject?.(method);
      if (failure !== undefined) throw failure;
      return (
        options.respond?.(method, params) ??
        (method === 'run' || method === 'chat'
          ? { runId: 'run-1', modelLabel: 'mock/m' }
          : method === 'catalog'
            ? { tools: [], models: [], guardrails: [], triggers: [] }
            : method === 'abort'
              ? { state: 'aborting' }
              : { ok: true })
      );
    }),
    onPush: vi.fn((runId: string, listener: (push: BridgePush) => void) => {
      pushes.set(runId, listener);
      return () => pushes.delete(runId);
    }),
    stop,
  } as unknown as BridgeClient;
  return { client, requests, pushes, emit: (runId, push) => pushes.get(runId)?.(push), stop };
}

function hostWith(stub: Stub, selection: HostSelection = BRIDGE_SELECTION): { host: BridgeAgentHost; events: HostEvent[]; input: HostRunInput } {
  const events: HostEvent[] = [];
  const host = new BridgeAgentHost(stub.client, {
    secretsStore,
    ready: async () => selection,
    fallbackCatalog: async () => FALLBACK,
    sdk: SDK,
  });
  const input: HostRunInput = { agentId: 'agent1', spec: SPEC, sessionId: 's1', input: 'hello', onEvent: (e) => events.push(e) };
  return { host, events, input };
}

const settledPush = (runId: string, finishReason = 'stop'): BridgePush =>
  ({ event: 'run.settled', runId, data: { finishReason, text: 'done' } }) as BridgePush;

// -- unit: start / pushes ------------------------------------------------------

describe('BridgeAgentHost.start', () => {
  it('sends run params and maps pushes to HostEvents until the terminal settle', async () => {
    const stub = stubClient();
    const { host, events, input } = hostWith(stub);
    const run = await host.start(input);
    expect(run).toEqual({ runId: 'run-1', modelLabel: 'mock/m' });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({
      method: 'run',
      params: { agentId: 'agent1', spec: SPEC, sessionId: 's1', input: 'hello' },
    });
    expect(stub.pushes.has('run-1')).toBe(true);

    stub.emit('run-1', { event: 'agent', runId: 'run-1', data: { type: 'text-delta', text: 'hi' } } as unknown as BridgePush);
    stub.emit('run-1', { event: 'span.start', runId: 'run-1', data: { id: 'sp1' } } as unknown as BridgePush);
    stub.emit('run-1', { event: 'span.end', runId: 'run-1', data: { id: 'sp1' } } as unknown as BridgePush);
    stub.emit('run-1', settledPush('run-1'));
    expect(events.map((e) => e.type)).toEqual(['agent', 'span', 'span', 'settled']);
    // Terminal settle unsubscribes: later pushes for the run go nowhere.
    expect(stub.pushes.has('run-1')).toBe(false);
    stub.emit('run-1', settledPush('run-1'));
    expect(events).toHaveLength(4);
  });

  it('keeps the subscription across an awaiting-approval settle', async () => {
    const stub = stubClient();
    const { host, input } = hostWith(stub);
    await host.start(input);
    stub.emit('run-1', settledPush('run-1', 'awaiting-approval'));
    expect(stub.pushes.has('run-1')).toBe(true);
  });

  it('uses chat with Message[] input and TypeErrors on ContentPart[]', async () => {
    const stub = stubClient();
    const { host, input } = hostWith(stub);
    const messages: Message[] = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ];
    await host.start({ ...input, input: messages });
    expect(stub.requests[0]).toMatchObject({ method: 'chat', params: { messages } });

    const stub2 = stubClient();
    const { host: host2 } = hostWith(stub2);
    await expect(
      host2.start({ ...input, input: [{ type: 'text', text: 'parts' }] as never })
    ).rejects.toBeInstanceOf(TypeError);
    expect(stub2.requests).toHaveLength(0);
  });

  it('sends named secrets and provider env, omitting unset values', async () => {
    secretsStore.setSecret('GH', 'ghp_x');
    secretsStore.setKey('openai', 'sk-test');
    const spec: AgentSpecV2 = {
      ...SPEC,
      mcpServers: { api: { url: 'https://x.test/mcp', headers: { Authorization: { secret: 'GH' }, Missing: { secret: 'NOPE' } } } } as AgentSpecV2['mcpServers'],
    };
    const stub = stubClient();
    const { host, input } = hostWith(stub);
    await host.start({ ...input, spec });
    const params = stub.requests[0]!.params as { secrets?: Record<string, string>; env?: Record<string, string> };
    expect(params.secrets).toEqual({ GH: 'ghp_x' });
    expect(params.env).toEqual({ OPENAI_API_KEY: 'sk-test' });
  });

  it('sends no secrets/env keys when the spec has no refs and no keys are stored', async () => {
    const stub = stubClient();
    const { host, input } = hostWith(stub);
    await host.start(input);
    const params = stub.requests[0]!.params as Record<string, unknown>;
    expect(params).not.toHaveProperty('secrets');
    expect(params).not.toHaveProperty('env');
  });

  it('wraps start failures in HostStartError with the bridge code', async () => {
    const stub = stubClient({ reject: () => new BridgeError('boom', 'LOUSHO_BRIDGE_CRASHED') });
    const { host, input } = hostWith(stub);
    const failure = await host.start(input).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(HostStartError);
    expect((failure as HostStartError).code).toBe('LOUSHO_BRIDGE_CRASHED');
  });
});

// -- unit: run controls ---------------------------------------------------------

describe('BridgeAgentHost run controls', () => {
  it('steer/abort/resolveApproval/answerQuestion send the bridge params', async () => {
    const stub = stubClient({ respond: (m) => (m === 'abort' ? { state: 'discarded' } : m === 'steer' ? { id: 'st1', applied: 'immediate' } : { ok: true }) });
    const { host } = hostWith(stub);
    await host.start({ agentId: 'a', spec: SPEC, sessionId: 's', input: 'hi', onEvent: () => {} });
    await expect(host.steer('run-1', 'more')).resolves.toEqual({ id: 'st1', applied: 'immediate' });
    await host.abort('run-1', 'user');
    await host.resolveApproval('run-1', 'ap1', { approved: true, note: 'n' });
    await host.answerQuestion('run-1', 'q1', 'yes');
    expect(stub.requests.map((r) => r.method)).toEqual(['run', 'steer', 'abort', 'resolveApproval', 'answerQuestion']);
    expect(stub.requests[1]!.params).toEqual({ runId: 'run-1', message: 'more' });
    expect(stub.requests[2]!.params).toEqual({ runId: 'run-1', reason: 'user' });
    expect(stub.requests[3]!.params).toEqual({ runId: 'run-1', approvalId: 'ap1', approved: true, note: 'n' });
    expect(stub.requests[4]!.params).toEqual({ runId: 'run-1', questionId: 'q1', answer: 'yes' });
    // 'discarded' abort unsubscribed the run's push listener.
    expect(stub.pushes.has('run-1')).toBe(false);
  });

  it.each(['LOUSHO_NO_ACTIVE_RUN', 'LOUSHO_BRIDGE_RUN_NOT_FOUND', 'LOUSHO_APPROVAL_NOT_FOUND'])(
    'maps %s to HostRunNotActiveError',
    async (code) => {
      const stub = stubClient({ reject: () => new BridgeError('gone', code) });
      const { host } = hostWith(stub);
      await expect(host.steer('run-1', 'x')).rejects.toBeInstanceOf(HostRunNotActiveError);
      await expect(host.abort('run-1')).rejects.toBeInstanceOf(HostRunNotActiveError);
      await expect(host.resolveApproval('run-1', 'a', { approved: true })).rejects.toBeInstanceOf(HostRunNotActiveError);
      await expect(host.answerQuestion('run-1', 'q', 'a')).rejects.toBeInstanceOf(HostRunNotActiveError);
    }
  );

  it('leaves other bridge errors unmapped', async () => {
    const stub = stubClient({ reject: () => new BridgeError('bad', 'LOUSHO_BRIDGE_TIMEOUT') });
    const { host } = hostWith(stub);
    const failure = await host.steer('run-1', 'x').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(BridgeError);
    expect(failure).not.toBeInstanceOf(HostRunNotActiveError);
  });
});

// -- unit: read-only + catalog + dispose ----------------------------------------

describe('BridgeAgentHost read-only and catalog', () => {
  it('read-only: mutating methods throw HostReadOnlyError, catalog falls back, dispose works', async () => {
    const stub = stubClient();
    const { host, input } = hostWith(stub, READ_ONLY_SELECTION);
    await expect(host.start(input)).rejects.toBeInstanceOf(HostReadOnlyError);
    await expect(host.steer('r', 'm')).rejects.toBeInstanceOf(HostReadOnlyError);
    await expect(host.catalog()).resolves.toBe(FALLBACK);
    expect(stub.requests).toHaveLength(0);
    await host.dispose();
    expect(stub.stop).toHaveBeenCalled();
  });

  it('catalog goes through the bridge and caches per hello catalogHash', async () => {
    const stub = stubClient();
    const { host } = hostWith(stub);
    const first = await host.catalog();
    const second = await host.catalog();
    expect(first).toEqual(second);
    expect(stub.requests.filter((r) => r.method === 'catalog')).toHaveLength(1);
    // A new handshake hash busts the cache.
    (stub.client as { hello: { catalogHash: string; sdkVersion: string } }).hello = { catalogHash: 'h2', sdkVersion: '1.0.0' };
    await host.catalog();
    expect(stub.requests.filter((r) => r.method === 'catalog')).toHaveLength(2);
  });

  it('dispose unsubscribes every run and stops the client', async () => {
    const stub = stubClient();
    const { host, input } = hostWith(stub);
    await host.start(input);
    expect(stub.pushes.size).toBe(1);
    await host.dispose();
    expect(stub.pushes.size).toBe(0);
    expect(stub.stop).toHaveBeenCalledTimes(1);
  });
});

// -- integration: the real built bridge -----------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SDK_DIST = path.join(REPO_ROOT, 'dist', 'cli', 'bridge.mjs');
const SCRIPTED_PROVIDER = fileURLToPath(new URL('./fixtures/scriptedProvider.mjs', import.meta.url));

interface RealBridge {
  host: BridgeAgentHost;
  client: BridgeClient;
  root: string;
  events: HostEvent[];
  stop(): Promise<void>;
}

async function realBridge(turns: unknown): Promise<RealBridge> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w11b-real-'));
  const nm = path.join(root, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  fs.mkdirSync(path.join(nm, '@linuxdevil'), { recursive: true });
  fs.symlinkSync(REPO_ROOT, path.join(nm, '@linuxdevil', '@linuxdevil/lousho'), 'junction');
  const sdk = findWorkspaceSdk(root);
  if (sdk === undefined) throw new Error('junction workspace did not resolve the SDK');
  const client = new BridgeClient(
    {
      command: process.execPath,
      args: ['--import', pathToFileURL(SCRIPTED_PROVIDER).href, sdk.binPath, 'bridge'],
      cwd: root,
      env: { ...process.env, LOUSHO_BRIDGE: '1', SCRIPTED_TURNS: JSON.stringify(turns) },
      label: 'w11b-real',
    },
    { clientVersion: 'w11b-test', stderr: () => undefined }
  );
  const host = new BridgeAgentHost(client, {
    secretsStore,
    ready: async () => BRIDGE_SELECTION,
    fallbackCatalog: async () => FALLBACK,
    sdk,
  });
  const events: HostEvent[] = [];
  return {
    host,
    client,
    root,
    events,
    stop: async () => {
      await host.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function inputFor(events: HostEvent[], spec: AgentSpecV2, input: HostRunInput['input']): HostRunInput {
  return { agentId: 'agent1', spec, sessionId: 's1', input, onEvent: (e) => events.push(e) };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const settledEvents = (events: HostEvent[]) => events.filter((e) => e.type === 'settled');

describe('BridgeAgentHost against the real bridge', () => {
  beforeEach(() => {
    if (!fs.existsSync(SDK_DIST)) {
      throw new Error('dist/cli/bridge.mjs missing - run npm run build at the repo root first');
    }
  });

  it('runs a scripted spec end to end: agent, span and settled HostEvents', async () => {
    const b = await realBridge(['ok']);
    try {
      const spec: AgentSpecV2 = { ...SPEC, model: 'scripted/x' };
      const run = await b.host.start(inputFor(b.events, spec, 'hello'));
      expect(run.runId).toBeTruthy();
      await waitFor(() => settledEvents(b.events).length > 0, 'run.settled');
      const types = b.events.map((e) => e.type);
      expect(types).toContain('agent');
      expect(types).toContain('span');
      const settled = settledEvents(b.events)[0]!;
      expect(settled.type === 'settled' && settled.result.finishReason).toBe('stop');
      expect(settled.type === 'settled' && settled.result.text).toBe('ok');
    } finally {
      await b.stop();
    }
  });

  it('pauses on an asked permission, then resolveApproval settles the continuation', async () => {
    const b = await realBridge([{ toolCalls: [{ name: 'current_date', args: {} }] }, 'after approval']);
    try {
      const spec: AgentSpecV2 = {
        ...SPEC,
        model: 'scripted/x',
        tools: [{ builtin: 'current_date' }],
        permissions: [{ id: 'p1', tool: 'current_date', action: 'ask' }],
      };
      const run = await b.host.start(inputFor(b.events, spec, 'hi'));
      await waitFor(() => settledEvents(b.events).length > 0, 'first settle');
      const paused = settledEvents(b.events)[0]!;
      expect(paused.type === 'settled' && paused.result.finishReason).toBe('awaiting-approval');
      const pending = paused.type === 'settled' ? paused.result.pendingApproval : undefined;
      expect(pending).toBeDefined();
      const approvalId = (pending as { id: string }).id;

      await b.host.resolveApproval(run.runId, approvalId, { approved: true });
      await waitFor(() => settledEvents(b.events).length > 1, 'continuation settle');
      const done = settledEvents(b.events)[1]!;
      expect(done.type === 'settled' && done.result.finishReason).toBe('stop');
      expect(done.type === 'settled' && done.result.text).toBe('after approval');
    } finally {
      await b.stop();
    }
  });

  it('abort winds a live run down to an aborted settle', async () => {
    const b = await realBridge([{ text: 'thinking', delayMs: 30_000 }]);
    try {
      const spec: AgentSpecV2 = { ...SPEC, model: 'scripted/x' };
      const run = await b.host.start(inputFor(b.events, spec, 'hi'));
      // The scripted turn delays 30 s; abort well inside that window.
      await new Promise((r) => setTimeout(r, 200));
      await b.host.abort(run.runId, 'user');
      await waitFor(() => settledEvents(b.events).length > 0, 'aborted settle', 15_000);
      const settled = settledEvents(b.events)[0]!;
      expect(settled.type === 'settled' && settled.result.finishReason).toBe('aborted');
    } finally {
      await b.stop();
    }
  });
});
