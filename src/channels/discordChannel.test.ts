/**
 * LOU-P6: `discordChannel()` - Ed25519 signatures (a real key pair, real
 * signatures), PING, a session per channel/thread, a deferred ack then an
 * edited reply, long-reply splitting and approvals as buttons. A fake `fetch`
 * stands in for the Discord API: no network.
 */
import type * as http from 'node:http';
import { Readable } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import type { Message } from '../providers';
import { mountChannels, type ChannelsHandler } from './mountChannels';
import { discordChannel } from './discordChannel';

const APP = 'app1';
const hex = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('hex');
const keys = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
const publicKey = hex(await crypto.subtle.exportKey('raw', keys.publicKey));

interface Call {
  method: string;
  url: string;
  body: { content: string; components?: Array<{ components: Array<{ custom_id: string }> }> };
}

/** A fake Discord API that records each webhook call; `log` interleaves calls and HTTP responses. */
function fakeDiscord() {
  const log: string[] = [];
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(url).replace(`https://discord.com/api/v10/webhooks/${APP}/`, ''), body: JSON.parse(String(init?.body)) });
    log.push(`${init?.method}`);
    return new Response('{}');
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, log };
}

interface SendOptions {
  badSignature?: boolean;
  omitSignature?: boolean;
}

/** Posts a really signed interaction to `handler`. */
async function send(handler: ChannelsHandler, log: string[], payload: unknown, options: SendOptions = {}) {
  const body = JSON.stringify(payload);
  const timestamp = '1700000000';
  const signed = await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(timestamp + (options.badSignature ? `${body} ` : body)));
  const headers = options.omitSignature ? {} : { 'x-signature-ed25519': hex(signed), 'x-signature-timestamp': timestamp };
  const req = Object.assign(Readable.from([Buffer.from(body)]), { method: 'POST', url: '/channels/discord', headers });
  const res = { status: 0, json: {} as Record<string, unknown> };
  const fakeRes = {
    writeHead: (status: number) => ((res.status = status), fakeRes),
    end: (text?: string) => {
      res.json = JSON.parse(text ?? '{}') as Record<string, unknown>;
      log.push('ack');
      return fakeRes;
    },
  };
  await handler(req as unknown as http.IncomingMessage, fakeRes as unknown as http.ServerResponse);
  return res;
}

function command(prompt: string, extra: Record<string, unknown> = {}) {
  return { type: 2, token: `tok-${prompt}`, guild_id: 'G1', channel_id: 'C1', channel: { id: 'C1', type: 0 }, member: { user: { id: 'U1' } }, data: { name: 'ask', options: [{ name: 'prompt', type: 3, value: prompt }] }, ...extra };
}

function setup(responses: Parameters<typeof mockModel>[0], agentOptions: Partial<Parameters<typeof createAgent>[0]> = {}) {
  const discord = fakeDiscord();
  const model = mockModel(responses);
  const agent = createAgent({ provider: model, ...agentOptions });
  const handler = mountChannels(agent, [discordChannel({ publicKey, applicationId: APP, fetch: discord.fetch })]);
  const userTexts = (call: number) => (model.calls[call].messages as Message[]).filter((m) => m.role === 'user').map((m) => m.content);
  return { ...discord, model, userTexts, send: (payload: unknown, options?: SendOptions) => send(handler, discord.log, payload, options) };
}

describe('discordChannel (LOU-P6)', () => {
  it('verifies Ed25519 signatures (401 when bad or missing) and answers PING with PONG', async () => {
    const t = setup(['never']);

    expect(await t.send({ type: 1 })).toEqual({ status: 200, json: { type: 1 } });
    expect((await t.send({ type: 1 }, { badSignature: true })).status).toBe(401);
    expect((await t.send({ type: 1 }, { omitSignature: true })).status).toBe(401);
    expect((await t.send(command('hi'), { badSignature: true })).status).toBe(401);
    expect(t.model.calls).toHaveLength(0);
    expect(() => discordChannel({ publicKey: 'abc', applicationId: APP })).toThrow(/publicKey/);
    expect(() => discordChannel({ publicKey, applicationId: '' })).toThrow(/applicationId/);
  });

  it('acks with a deferred response, then edits the original; one session per channel, another per thread', async () => {
    const t = setup(['Hi Ali', 'You are Ali', 'Other thread']);

    expect(await t.send(command('I am Ali'))).toEqual({ status: 200, json: { type: 5 } });
    await t.send(command('Who am I?'));
    const thread = { channel_id: 'T1', channel: { id: 'T1', type: 11, parent_id: 'C1' } };
    await t.send(command('Who am I?', thread));

    expect(t.log.slice(0, 2)).toEqual(['ack', 'PATCH']);
    expect(t.calls.map((c) => [c.method, c.url, c.body.content])).toEqual([
      ['PATCH', 'tok-I am Ali/messages/@original', 'Hi Ali'],
      ['PATCH', 'tok-Who am I?/messages/@original', 'You are Ali'],
      ['PATCH', 'tok-Who am I?/messages/@original', 'Other thread'],
    ]);
    expect(t.userTexts(1)).toEqual(['I am Ali', 'Who am I?']);
    expect(t.userTexts(2)).toEqual(['Who am I?']);
  });

  it('tells the user the command shape when there is no prompt', async () => {
    const t = setup(['never']);

    const res = await t.send(command('', { data: { name: 'ask', options: [] } }));

    expect(res.json).toMatchObject({ type: 4, data: { content: expect.stringContaining('/ask prompt:') } });
    expect(t.model.calls).toHaveLength(0);
  });

  it('splits a reply over 2000 characters into the edit plus follow-up messages', async () => {
    const long = `${'a'.repeat(1500)}\n${'b'.repeat(1500)}\n${'c'.repeat(500)}`;
    const t = setup([long]);

    await t.send(command('write a lot'));

    expect(t.calls.map((c) => [c.method, c.url])).toEqual([
      ['PATCH', 'tok-write a lot/messages/@original'],
      ['POST', 'tok-write a lot'],
      ['POST', 'tok-write a lot'],
    ]);
    expect(t.calls.every((c) => c.body.content.length <= 2000)).toBe(true);
    expect(t.calls.map((c) => c.body.content).join('\n')).toBe(long);
  });

  it('posts Approve / Deny buttons and resumes the session from the click, replying as a follow-up', async () => {
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const tool = defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
    const call = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_email' }] };
    const t = setup([call, 'Email sent.'], { tools: [tool] });

    await t.send(command('Email Sam'));

    const [approve, deny] = t.calls[0].body.components?.[0].components ?? [];
    expect(approve.custom_id).toMatch(/^loushy_approve:/);
    expect(deny.custom_id).toMatch(/^loushy_deny:/);
    expect(execute).not.toHaveBeenCalled();

    const click = { type: 3, token: 'tok-click', message: { content: 'Approve?' }, data: { custom_id: approve.custom_id } };
    expect((await t.send(click, { badSignature: true })).status).toBe(401);
    expect(await t.send(click)).toEqual({ status: 200, json: { type: 7, data: { content: 'Approve?\nApproved.', components: [] } } });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(t.calls[1]).toMatchObject({ method: 'POST', url: 'tok-click', body: { content: 'Email sent.' } });
  });

  it('posts an ask_question as text and takes the next /ask as the answer', async () => {
    const ask = { toolCalls: [{ name: 'ask_question', args: { question: 'Which city?' }, id: 'call_q' }] };
    const t = setup([ask, 'Booked Lisbon.'], { askQuestion: true });

    await t.send(command('Book a trip'));
    expect(t.calls[0].body.content).toContain('Which city?');

    await t.send(command('Lisbon'));

    expect(t.calls[1]).toMatchObject({ method: 'PATCH', url: 'tok-Lisbon/messages/@original', body: { content: 'Booked Lisbon.' } });
    expect(JSON.stringify(t.model.calls[1].messages)).toContain('Lisbon');
  });
});
