/** `GET /ready` of the node server: readiness, separate from the `/health` liveness probe. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { createDeployedServer, type DeployedServerOptions } from './nodeServer';

const CRLF = '\r\n';
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function start(options: DeployedServerOptions = { env: {} }, tools: ReturnType<typeof defineTool>[] = []) {
  const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'slow', args: {} }] }, 'done']), instructions: 'x', tools });
  closers.push(() => agent.close());
  const deployed = createDeployedServer(agent, options);
  closers.push(() => deployed.shutdown({ timeoutMs: 50 }));
  await new Promise<void>((done) => deployed.server.listen(0, '127.0.0.1', done));
  return { ...deployed, url: `http://127.0.0.1:${(deployed.server.address() as AddressInfo).port}` };
}

describe('GET /ready', () => {
  it('answers 200 ready while serving, and leaves /health as ok', async () => {
    const { url } = await start();
    const ready = await fetch(`${url}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');
  });

  it('needs no auth even with LOUSHO_API_TOKEN set', async () => {
    const { url } = await start({ env: { LOUSHO_API_TOKEN: 'secret' } });
    expect((await fetch(`${url}/ready`)).status).toBe(200);
    expect((await fetch(`${url}/chat/abc`)).status).toBe(401);
  });

  it('answers 503 draining once shutdown has begun', async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const started = vi.fn();
    const slow = defineTool({ name: 'slow', description: 'Takes a while', input: z.object({}), execute: async () => (started(), await gate, 'finished') });
    const { url, shutdown } = await start({ env: {} }, [slow]);
    // A probe whose request is half sent when shutdown starts is not an idle connection, so shutdown leaves it open.
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(new URL(url).port) });
    closers.push(async () => socket.destroy());
    await new Promise<void>((done) => socket.once('connect', done));
    socket.write(['GET /ready HTTP/1.1', 'Host: localhost', 'Connection: close', ''].join(CRLF));
    await new Promise((done) => setTimeout(done, 20));

    const turn = fetch(`${url}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'go' }) });
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    const stopping = shutdown({ timeoutMs: 5_000 });
    let raw = '';
    socket.on('data', (chunk) => (raw += chunk));
    socket.write(CRLF);
    await vi.waitFor(() => expect(raw).toContain('{"status":"draining"}'));
    expect(raw.split(CRLF)[0]).toBe('HTTP/1.1 503 Service Unavailable');
    release();
    await turn;
    await stopping;
  });
});
