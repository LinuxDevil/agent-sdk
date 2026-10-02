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
import { InMemoryApprovalStore } from '../execution/InMemoryApprovalStore';
import { MemorySessionStore } from '../session/sessionStore';
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

interface SetupOptions {
  channel?: Partial<Parameters<typeof discordChannel>[0]>;
  mount?: Parameters<typeof mountChannels>[2];
}

/** A button click of `user` (default: the command's author U1) on the approval message. */
function click(customId: string, user = 'U1', extra: Record<string, unknown> = {}) {
  return { type: 3, token: 'tok-click', guild_id: 'G1', channel_id: 'C1', channel: { id: 'C1', type: 0 }, member: { user: { id: user, username: `name-${user}` }, roles: ['R1'] }, message: { content: 'Approve?' }, data: { custom_id: customId }, ...extra };
}

const emailTool = (execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`)) =>
  defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
const emailCall = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_email' }] };

function setup(responses: Parameters<typeof mockModel>[0], agentOptions: Partial<Parameters<typeof createAgent>[0]> = {}, extra: SetupOptions = {}) {
  const discord = fakeDiscord();
  const model = mockModel(responses);
  const agent = createAgent({ provider: model, ...agentOptions });
  const handler = mountChannels(agent, [discordChannel({ publicKey, applicationId: APP, fetch: discord.fetch, ...extra.channel })], extra.mount);
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
    expect(approve.custom_id).toMatch(/^lousho_approve:/);
    expect(deny.custom_id).toMatch(/^lousho_deny:/);
    expect(execute).not.toHaveBeenCalled();

    const approval = click(approve.custom_id);
    expect((await t.send(approval, { badSignature: true })).status).toBe(401);
    expect(await t.send(approval)).toEqual({ status: 200, json: { type: 7, data: { content: 'Approve?\nApproved by <@U1>.', components: [], allowed_mentions: { parse: [] } } } });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(t.calls[1]).toMatchObject({ method: 'POST', url: 'tok-click', body: { content: 'Email sent.' } });
  });

  /** Runs a command that pauses on `send_email` and returns the custom id of its Approve button. */
  async function pause(t: ReturnType<typeof setup>) {
    await t.send(command('Email Sam'));
    return t.calls[0].body.components?.[0].components[0].custom_id ?? '';
  }

  it('only the user who ran the command may approve by default; others get an ephemeral refusal and it stays pending', async () => {
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] });
    const id = await pause(t);

    expect(await t.send(click(id, 'U2'))).toEqual({ status: 200, json: { type: 4, data: { content: 'You are not allowed to approve this request.', flags: 64 } } });

    expect(execute).not.toHaveBeenCalled();
    expect((await t.send(click(id, 'U1'))).json).toMatchObject({ type: 7 });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('approvers as a list of user ids', async () => {
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] }, { channel: { approvers: ['U9'] } });
    const id = await pause(t);

    expect((await t.send(click(id, 'U1'))).json).toMatchObject({ type: 4 });
    expect(execute).not.toHaveBeenCalled();
    expect((await t.send(click(id, 'U9'))).json).toMatchObject({ type: 7 });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('approvers as a function sees the user (with roles) and the tool request, and the approver is recorded', async () => {
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const approvers = vi.fn(async (user: { roles?: string[] }) => user.roles?.includes('ADMIN') === true);
    const onDecision = vi.fn();
    const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] }, { channel: { approvers }, mount: { onDecision } });
    const id = await pause(t);

    expect((await t.send(click(id))).json).toMatchObject({ type: 4 });
    expect((await t.send(click(id, 'U3', { member: { user: { id: 'U3' }, roles: ['ADMIN'] } }))).json).toMatchObject({ type: 7 });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(approvers).toHaveBeenLastCalledWith({ id: 'U3', name: undefined, roles: ['ADMIN'] }, { toolName: 'send_email', input: { to: 'sam@example.com' }, sessionId: expect.stringMatching(/^discord_G1_C1-/) });
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ approver: expect.objectContaining({ id: 'U3' }), channel: 'discord' }));
  });

  it('reports a failed reply to onError (never throws)', async () => {
    const onError = vi.fn();
    const failing = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof globalThis.fetch;
    const t = setup(['Hello'], {}, { channel: { onError, fetch: failing } });

    expect((await t.send(command('hi'))).json).toEqual({ type: 5 });

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('500') }), { channel: 'discord', stage: 'reply', sessionId: expect.stringContaining('discord') });
  });

  it('a failed turn goes to onError and the user is told in the channel', async () => {
    const onError = vi.fn();
    const t = setup([{ error: new Error('model down') }], {}, { channel: { onError } });

    await t.send(command('hi'));

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'model down' }), { channel: 'discord', stage: 'turn', sessionId: expect.stringContaining('discord') });
    expect(t.calls.map((c) => c.body.content)).toEqual(['Sorry, that request failed.']);
  });

  it('a click still resolves after a restart: a second channel over the same stores', async () => {
    const approvalStore = new InMemoryApprovalStore();
    const store = new MemorySessionStore();
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const id = await pause(setup([emailCall], { tools: [emailTool(execute)], approvalStore }, { mount: { store } }));

    const second = setup(['Email sent.'], { tools: [emailTool(execute)], approvalStore }, { mount: { store } });
    await second.send(click(id));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(second.calls[0]).toMatchObject({ method: 'POST', url: 'tok-click', body: { content: 'Email sent.' } });
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
