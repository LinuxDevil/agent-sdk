/** The node server mounts the channels of the agent directory it serves. */
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { defineChannel } from '../channels/defineChannel';
import { createDeployedServer } from './nodeServer';
import { memoryStore } from '../storage/agentStore';
import { channelSessionId } from '../channels/defineChannel';
import { httpChannel } from '../channels/httpChannel';
import { webhookChannel } from '../channels/webhookChannel';
import { createHmac } from 'node:crypto';
import type { Channel } from '../channels/defineChannel';
import type { SimpleAgent } from '../createAgent';

const BEARER = { authorization: 'Bearer secret' };

/** Listens on a free port; resolves the base URL and a closer. */
async function listen(agent: SimpleAgent, channels: readonly Channel[], env: NodeJS.ProcessEnv = { LOUSHO_API_TOKEN: 'secret' }) {
  const deployed = createDeployedServer(agent, { env, channels });
  await new Promise<void>((resolve) => deployed.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(deployed.server.address() as AddressInfo).port}`;
  const close = async () => {
    await new Promise((resolve) => deployed.server.close(resolve));
    await agent.close();
  };
  return { base, close, channelRoutes: deployed.channelRoutes };
}

describe('node server channels', () => {
  it('routes POST /channels/<name> to an agent turn and sends the reply through the channel', async () => {
    const agent = createAgent({ provider: mockModel(['pong']), instructions: 'x' });
    const sent: string[] = [];
    const sms = defineChannel({
      name: 'sms',
      async parse(req) {
        const { from, body } = JSON.parse(req.text) as { from: string; body: string };
        return { sessionKey: from, input: body, replyTo: from };
      },
      async reply({ inbound, text }) {
        sent.push(`${String(inbound.replyTo)}:${text}`);
      },
    });
    const { server } = createDeployedServer(agent, { env: { LOUSHO_API_TOKEN: 'secret' }, channels: [sms] });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const hook = await fetch(`${base}/channels/sms`, { method: 'POST', headers: BEARER, body: JSON.stringify({ from: '+1', body: 'ping' }) });
    expect(hook.status).toBe(200);
    expect(sent).toEqual(['+1:pong']);
    // The chat routes stay behind the bearer token, like the channel (it has no verify of its own).
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/sessions`)).status).toBe(401);

    await new Promise((resolve) => server.close(resolve));
    await agent.close();
  });

  it("keeps channel transcripts in the agent's store", async () => {
    const store = memoryStore();
    const agent = createAgent({ provider: mockModel(['pong']), instructions: 'x', store });
    const sms = defineChannel({
      name: 'sms',
      async parse(req) {
        const { from, body } = JSON.parse(req.text) as { from: string; body: string };
        return { sessionKey: from, input: body, replyTo: from };
      },
      async reply() {},
    });
    const { server } = createDeployedServer(agent, { env: { LOUSHO_API_TOKEN: 'secret' }, channels: [sms] });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    expect((await fetch(`${base}/channels/sms`, { method: 'POST', headers: BEARER, body: JSON.stringify({ from: '+1', body: 'ping' }) })).status).toBe(200);
    const id = channelSessionId(sms, { sessionKey: '+1', input: '', replyTo: undefined });
    expect(await store.sessions.load(id)).toHaveLength(2);

    await new Promise((resolve) => server.close(resolve));
    await agent.close();
  });

  describe('route auth', () => {
    const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

    it('puts a channel without verify behind LOUSHO_API_TOKEN', async () => {
      const { base, close, channelRoutes } = await listen(createAgent({ provider: mockModel(['pong', 'pong']), instructions: 'x' }), [httpChannel()]);
      try {
        expect((await fetch(`${base}/channels/http`, json({ sessionKey: 'alice', input: 'hi' }))).status).toBe(401);
        expect((await fetch(`${base}/channels/http`, json({ sessionKey: 'alice', input: 'hi' }, { authorization: 'Bearer wrong' }))).status).toBe(401);
        expect((await fetch(`${base}/channels/http/approvals/a1`, json({ approved: true }))).status).toBe(401);
        const ok = await fetch(`${base}/channels/http`, json({ sessionKey: 'alice', input: 'hi' }, BEARER));
        expect(ok.status).toBe(200);
        expect(((await ok.json()) as { text: string }).text).toBe('pong');
        expect(channelRoutes).toEqual([{ name: 'http', auth: 'server-auth' }]);
      } finally {
        await close();
      }
    });

    it('leaves a channel with its own verify reachable without the bearer token', async () => {
      const api = httpChannel({ verify: async (req) => req.headers['x-api-key'] === 'k' });
      const { base, close, channelRoutes } = await listen(createAgent({ provider: mockModel(['pong']), instructions: 'x' }), [api]);
      try {
        expect((await fetch(`${base}/channels/http`, json({ sessionKey: 'a', input: 'hi' }, { 'x-api-key': 'nope' }))).status).toBe(401);
        expect((await fetch(`${base}/channels/http`, json({ sessionKey: 'a', input: 'hi' }, { 'x-api-key': 'k' }))).status).toBe(200);
        expect(channelRoutes).toEqual([{ name: 'http', auth: 'self-verified' }]);
      } finally {
        await close();
      }
    });

    it('leaves a signed platform channel (webhook with a secret) reachable without the bearer token', async () => {
      const body = JSON.stringify({ input: 'deploy failed' });
      const signature = `sha256=${createHmac('sha256', 'hook-secret').update(body).digest('hex')}`;
      const hook = webhookChannel({ secret: 'hook-secret' });
      const { base, close, channelRoutes } = await listen(createAgent({ provider: mockModel(['ack']), instructions: 'x' }), [hook, httpChannel()]);
      try {
        expect((await fetch(`${base}/channels/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(401);
        expect((await fetch(`${base}/channels/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-256': signature }, body })).status).toBe(200);
        expect(channelRoutes).toEqual([
          { name: 'webhook', auth: 'self-verified' },
          { name: 'http', auth: 'server-auth' },
        ]);
      } finally {
        await close();
      }
    });

    it('reports a channel without verify as open when no token is configured', async () => {
      const { base, close, channelRoutes } = await listen(createAgent({ provider: mockModel(['pong']), instructions: 'x' }), [httpChannel()], {});
      try {
        expect((await fetch(`${base}/channels/http`, json({ sessionKey: 'a', input: 'hi' }))).status).toBe(200);
        expect(channelRoutes).toEqual([{ name: 'http', auth: 'open' }]);
      } finally {
        await close();
      }
    });
  });
});
