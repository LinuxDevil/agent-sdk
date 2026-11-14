import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgePush } from '@linuxdevil/lousho';
import { BridgeClient, type BridgeState } from '../host/bridgeClient';

const FAKE_BRIDGE = fileURLToPath(new URL('../host/__tests__/fakeBridge.mjs', import.meta.url));

const dirs: string[] = [];
const clients: BridgeClient[] = [];

function makeClient(mode?: string, overrides: Record<string, unknown> = {}): BridgeClient {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-bridge-client-'));
  dirs.push(dir);
  const client = new BridgeClient(
    {
      command: process.execPath,
      args: [FAKE_BRIDGE],
      cwd: dir,
      env: { ...process.env, ...(mode !== undefined && { FAKE_BRIDGE_MODE: mode }) },
      label: 'test-ws',
    },
    {
      clientVersion: '0.0.0-test',
      timeouts: { hello: 500, catalog: 300, compile: 300, run: 300, chat: 300, resolveApproval: 300, answerQuestion: 300, steer: 300, abort: 300, shutdown: 300 },
      backoffMs: [20, 40, 60, 80, 100, 120],
      stderr: () => undefined,
      ...overrides,
    }
  );
  clients.push(client);
  return client;
}

function waitForState(client: BridgeClient, state: BridgeState, ms = 5_000): Promise<void> {
  if (client.state === state) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for state ${state} (now ${client.state})`)), ms);
    client.onStateChange((next) => {
      if (next === state) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  // A just-killed child can take a moment to release its cwd on Windows.
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('BridgeClient', () => {
  it('starts against the fake bridge and reports hello.protocol 1', async () => {
    const client = makeClient();
    const hello = await client.start();
    expect(client.state).toBe('ready');
    expect(hello.protocol).toBe(1);
    expect(hello.sdkVersion).toBe('0.0.0-fake');
    // Idempotent while ready.
    await expect(client.start()).resolves.toBe(hello);
  });

  it('maps an SDK without the bridge command to LOUSHO_BRIDGE_UNSUPPORTED and never respawns', async () => {
    const client = makeClient('unknown-command');
    await expect(client.start()).rejects.toMatchObject({ code: 'LOUSHO_BRIDGE_UNSUPPORTED' });
    expect(client.state).toBe('unsupported');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.state).toBe('unsupported');
    await expect(client.request('catalog', {})).rejects.toMatchObject({ code: 'LOUSHO_BRIDGE_UNSUPPORTED' });
  });

  it('times out a silent hello and kills the child', async () => {
    const client = makeClient('silent');
    await expect(client.start()).rejects.toMatchObject({ code: 'LOUSHO_BRIDGE_TIMEOUT' });
    expect(client.state).toBe('failed');
  });

  it('delivers a push that arrived in the same chunk as its response', async () => {
    const client = makeClient();
    await client.start();
    const started = await client.request('run', {
      agentId: 'a',
      spec: {} as never,
      sessionId: 's',
      input: 'hi',
    });
    expect(started.runId).toBe('run-1');
    // The fake wrote the response and run.settled back-to-back; the push is
    // buffered when it lands before onPush, or delivered straight to the
    // listener when it lands after — either way it must arrive.
    const pushes: BridgePush[] = [];
    client.onPush('run-1', (push) => pushes.push(push));
    const deadline = Date.now() + 2_000;
    while (pushes.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ event: 'run.settled', runId: 'run-1' });
  });

  it('rejects a request the bridge never answers with LOUSHO_BRIDGE_TIMEOUT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-bridge-client-'));
    dirs.push(dir);
    const hanging = new BridgeClient(
      {
        command: process.execPath,
        args: [FAKE_BRIDGE],
        cwd: dir,
        env: { ...process.env, FAKE_BRIDGE_HANG: 'catalog' },
        label: 'test-ws',
      },
      {
        clientVersion: '0.0.0-test',
        timeouts: { hello: 500, catalog: 100 },
        backoffMs: [20],
        stderr: () => undefined,
      }
    );
    clients.push(hanging);
    await hanging.start();
    await expect(hanging.request('catalog', {})).rejects.toMatchObject({ code: 'LOUSHO_BRIDGE_TIMEOUT' });
    // The bridge is still alive and well.
    await expect(hanging.request('run', { agentId: 'a', spec: {} as never, sessionId: 's', input: 'hi' })).resolves.toMatchObject({ runId: 'run-1' });
  });

  it('rejects pending work on crash, pushes a synthetic run.failed, and respawns', async () => {
    const client = makeClient('crash-after-hello');
    await client.start();
    const pushes: BridgePush[] = [];
    client.onPush('run-1', (push) => pushes.push(push));
    await expect(
      client.request('run', { agentId: 'a', spec: {} as never, sessionId: 's', input: 'hi' })
    ).rejects.toMatchObject({ code: 'LOUSHO_BRIDGE_CRASHED' });
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ event: 'run.failed', runId: 'run-1' });
    expect((pushes[0].data as { code: string }).code).toBe('LOUSHO_BRIDGE_CRASHED');
    await waitForState(client, 'ready');
    // The respawned bridge handshakes again.
    expect(client.hello?.sdkVersion).toBe('0.0.0-fake');
  });

  it('fails after five crashes in the window and recovers via restart()', async () => {
    const client = makeClient('crash-after-hello');
    for (let i = 0; i < 5; i++) {
      await waitForState(client, i === 0 ? 'idle' : 'ready').then(() => client.start());
      await expect(client.request('catalog', {})).rejects.toMatchObject({ code: 'LOUSHO_BRIDGE_CRASHED' });
      if (i < 4) await waitForState(client, 'ready');
    }
    await waitForState(client, 'failed');
    await expect(client.request('catalog', {})).rejects.toMatchObject({ code: 'LOUSHO_BRIDGE_FAILED' });
    const hello = await client.restart();
    expect(client.state).toBe('ready');
    expect(hello.protocol).toBe(1);
  });

  it('routes non-JSON stdout to the stderr sink and keeps serving requests', async () => {
    const lines: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'lousho-bridge-client-'));
    dirs.push(dir);
    const client = new BridgeClient(
      {
        command: process.execPath,
        args: [FAKE_BRIDGE],
        cwd: dir,
        env: { ...process.env, FAKE_BRIDGE_MODE: 'garbage' },
        label: 'test-ws',
      },
      { clientVersion: '0.0.0-test', timeouts: { hello: 500, catalog: 300 }, backoffMs: [20], stderr: (line) => lines.push(line) }
    );
    clients.push(client);
    await client.start();
    await client.request('catalog', {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lines.some((line) => line.startsWith('non-protocol output:'))).toBe(true);
    expect(client.recentStderr().length).toBeGreaterThan(0);
  });

  it('stop() sends shutdown and lands in stopped', async () => {
    const client = makeClient();
    await client.start();
    await client.stop();
    expect(client.state).toBe('stopped');
  });

  it('stop() on a child that ignores shutdown still terminates it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-bridge-client-'));
    dirs.push(dir);
    const client = new BridgeClient(
      {
        command: process.execPath,
        args: [FAKE_BRIDGE],
        cwd: dir,
        env: { ...process.env, FAKE_BRIDGE_HANG: 'shutdown' },
        label: 'test-ws',
      },
      {
        clientVersion: '0.0.0-test',
        timeouts: { hello: 500, shutdown: 100 },
        backoffMs: [20],
        stderr: () => undefined,
      }
    );
    clients.push(client);
    await client.start();
    await client.stop();
    expect(client.state).toBe('stopped');
  });
});
