/** LOU-P7.2: the node server mounts the channels of the agent directory it serves. */
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { defineChannel } from '../channels/defineChannel';
import { createDeployedServer } from './nodeServer';
import { memoryStore } from '../storage/agentStore';
import { channelSessionId } from '../channels/defineChannel';

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

    const hook = await fetch(`${base}/channels/sms`, { method: 'POST', body: JSON.stringify({ from: '+1', body: 'ping' }) });
    expect(hook.status).toBe(200);
    expect(sent).toEqual(['+1:pong']);
    // The chat routes stay behind the bearer token, next to the channels.
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/sessions`)).status).toBe(401);

    await new Promise((resolve) => server.close(resolve));
    await agent.close();
  });

  it("keeps channel transcripts in the agent's store (Eve channels-server F1)", async () => {
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

    expect((await fetch(`${base}/channels/sms`, { method: 'POST', body: JSON.stringify({ from: '+1', body: 'ping' }) })).status).toBe(200);
    const id = channelSessionId(sms, { sessionKey: '+1', input: '', replyTo: undefined });
    expect(await store.sessions.load(id)).toHaveLength(2);

    await new Promise((resolve) => server.close(resolve));
    await agent.close();
  });
});
