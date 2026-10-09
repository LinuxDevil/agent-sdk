/**
 * Eve DUR-F15: `createDeployedServer().shutdown()` drains the node server on
 * SIGTERM - it stops accepting, stops the schedules, waits (bounded) for the
 * turns in flight, then closes what is left - instead of `agent.close()`
 * cutting running turns off.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { defineSchedule } from '../schedules/defineSchedule';
import { createDeployedServer } from './nodeServer';
import { NodeServerAdapter } from './adapters/node-server';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/** A server whose agent's `slow` tool waits until `release()`. */
async function slowServer() {
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  const started = vi.fn();
  const slow = defineTool({
    name: 'slow',
    description: 'Takes a while',
    input: z.object({}),
    execute: async () => (started(), await gate, 'finished'),
  });
  const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'slow', args: {} }] }, 'done after slow']), instructions: 'x', tools: [slow] });
  closers.push(() => agent.close());
  const deployed = createDeployedServer(agent, { env: {} });
  closers.push(() => deployed.shutdown({ timeoutMs: 50 }));
  await new Promise<void>((done) => deployed.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(deployed.server.address() as AddressInfo).port}`;
  return { ...deployed, url, release, started };
}

describe('createDeployedServer().shutdown() (Eve DUR-F15)', () => {
  it('stops accepting, lets the turn in flight finish, then resolves', async () => {
    const { url, shutdown, release, started } = await slowServer();
    const turn = fetch(`${url}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'go' }) });
    await vi.waitFor(() => expect(started).toHaveBeenCalled());

    let drained = false;
    const stopping = shutdown({ timeoutMs: 5_000 }).then(() => (drained = true));
    await new Promise((done) => setTimeout(done, 50));
    expect(drained).toBe(false);
    await expect(fetch(`${url}/health`)).rejects.toThrow();

    release();
    const response = await turn;
    expect(response.status).toBe(200);
    expect(((await response.json()) as { text: string }).text).toBe('done after slow');
    await stopping;
    expect(drained).toBe(true);
  });

  it('gives up waiting after timeoutMs and closes the connections left', async () => {
    const { url, shutdown, started, release } = await slowServer();
    const turn = fetch(`${url}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'go' }) }).catch((error: Error) => error);
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const start = Date.now();
    await shutdown({ timeoutMs: 100 });
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('still running after 100 ms'));
    expect(await turn).toBeInstanceOf(Error);
    warn.mockRestore();
    release();
  });

  it('stops the schedules first, so nothing fires while it drains', async () => {
    const agent = createAgent({ provider: mockModel(['x']), instructions: 'x' });
    closers.push(() => agent.close());
    const cancel = vi.fn();
    const deployed = createDeployedServer(agent, {
      env: {},
      schedules: [defineSchedule({ cron: '* * * * *', run: async () => undefined })],
      scheduler: { setTimer: () => cancel },
    });
    await new Promise<void>((done) => deployed.server.listen(0, '127.0.0.1', done));
    await deployed.shutdown();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(deployed.server.listening).toBe(false);
  });

  it('is what the generated server runs on SIGTERM, before agent.close()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-shutdown-'));
    closers.push(async () => rmSync(dir, { recursive: true, force: true }));
    const specPath = join(dir, 'agent.json');
    writeFileSync(specPath, JSON.stringify({ name: 'a', prompt: 'x', provider: { type: 'mock', model: 'm' } }));
    await NodeServerAdapter.scaffold(specPath, join(dir, 'out'));
    const source = readFileSync(join(dir, 'out', 'server.ts'), 'utf8');
    expect(source).toContain('shutdown({ timeoutMs: shutdownTimeoutMs })');
    expect(source).toContain('LOUSHO_SHUTDOWN_TIMEOUT_MS');
    expect(source.indexOf('shutdown({ timeoutMs')).toBeLessThan(source.indexOf('agent.close()'));
  });
});
