/**
 * LOU-P7: channels - an inbound request maps to a session turn, the reply
 * goes back through the channel, `verify` guards it, and pauses go through
 * `onApproval` and `resolveApproval()`.
 */
import { describe, it, expect, vi } from 'vitest';
import type * as http from 'node:http';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import type { Message } from '../providers';
import { channelSessionId, defineChannel, type Channel, type ChannelReplyContext } from './defineChannel';
import { mountChannels, type ChannelsHandler } from './mountChannels';
import { httpChannel } from './httpChannel';

interface Posted {
  handled: boolean;
  status: number;
  json: Record<string, unknown>;
}

/** Drives `handler` with a fake `node:http` request and response pair. */
async function post(handler: ChannelsHandler, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Posted> {
  const req = Object.assign(Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]), { method: 'POST', url: path, headers });
  const res = { status: 0, body: '' };
  const fakeRes = {
    writeHead: (status: number) => ((res.status = status), fakeRes),
    end: (text?: string) => ((res.body = text ?? ''), fakeRes),
  };
  const handled = await handler(req as unknown as http.IncomingMessage, fakeRes as unknown as http.ServerResponse);
  return { handled, status: res.status, json: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {} };
}

/** A channel that records every reply instead of sending it anywhere. */
function recordingChannel(overrides: Partial<Channel> = {}) {
  const replies: ChannelReplyContext[] = [];
  const channel = defineChannel({
    name: 'test',
    async parse(req) {
      const { user, text } = JSON.parse(req.text) as { user: string; text: string };
      return { sessionKey: user, input: text, replyTo: `dm:${user}`, metadata: { user } };
    },
    async reply(ctx) {
      replies.push(ctx);
    },
    ...overrides,
  });
  return { channel, replies };
}

function emailTool() {
  const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
  const tool = defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
  return { tool, execute };
}

const callEmail = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_email' }] };

describe('defineChannel / mountChannels (LOU-P7)', () => {
  it('runs inbound -> session -> reply and answers the open request', async () => {
    const agent = createAgent({ provider: mockModel(['Hello Ali']) });
    const { channel, replies } = recordingChannel();
    const handler = mountChannels(agent, [channel]);

    const res = await post(handler, '/channels/test', { user: 'ali', text: 'hi' });

    expect(res).toEqual({ handled: true, status: 200, json: { ok: true } });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ text: 'Hello Ali', inbound: { replyTo: 'dm:ali', metadata: { user: 'ali' } } });
    expect(replies[0].result?.finishReason).toBe('stop');
    expect(replies[0].events?.at(-1)?.type).toBe('run.done');
    expect(replies[0].sessionId).toBe(channelSessionId(channel, replies[0].inbound));
    expect(replies[0].sessionId).toMatch(/^test_ali-[0-9a-z]+$/);
  });

  it('httpChannel answers with plain JSON and leaves other routes to the host', async () => {
    const agent = createAgent({ provider: mockModel(['Pong']) });
    const handler = mountChannels(agent, [httpChannel()], { basePath: '/hooks/' });

    const res = await post(handler, '/hooks/http', { sessionKey: 'u1', input: 'ping' });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ text: 'Pong', finishReason: 'stop', sessionId: expect.stringMatching(/^http_u1-/) });
    expect((await post(handler, '/hooks/other', {})).handled).toBe(false);
    expect((await post(handler, '/chat', {})).handled).toBe(false);
    expect((await post(handler, '/hooks/http', { input: 'no key' })).status).toBe(400);
  });

  it('rejects a request that fails verify with 401, before parsing or running', async () => {
    const model = mockModel(['never']);
    const parse = vi.fn();
    const { channel, replies } = recordingChannel({ verify: async () => ({ ok: false, reason: 'bad signature' }), parse });
    const handler = mountChannels(createAgent({ provider: model }), [channel]);

    const res = await post(handler, '/channels/test', { user: 'ali', text: 'hi' });

    expect(res).toMatchObject({ status: 401, json: { error: 'Unauthorized' } });
    expect(parse).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });

  it('shares history between events with the same sessionKey, not across keys', async () => {
    const model = mockModel(['Nice to meet you', 'You are Ali', 'Who?']);
    const { channel, replies } = recordingChannel();
    const handler = mountChannels(createAgent({ provider: model }), [channel]);

    await post(handler, '/channels/test', { user: 'ali', text: 'I am Ali' });
    await post(handler, '/channels/test', { user: 'ali', text: 'Who am I?' });
    await post(handler, '/channels/test', { user: 'sam', text: 'Who am I?' });

    const userTexts = (call: number) => (model.calls[call].messages as Message[]).filter((m) => m.role === 'user').map((m) => m.content);
    expect(userTexts(1)).toEqual(['I am Ali', 'Who am I?']);
    expect(userTexts(2)).toEqual(['Who am I?']);
    expect(replies[0].sessionId).toBe(replies[1].sessionId);
    expect(replies[2].sessionId).not.toBe(replies[0].sessionId);
  });

  it('a null parse is acknowledged without a turn', async () => {
    const model = mockModel(['never']);
    const { channel } = recordingChannel({ parse: async () => null });
    const res = await post(mountChannels(createAgent({ provider: model }), [channel]), '/channels/test', {});
    expect(res.json).toEqual({ ok: true });
    expect(model.calls).toHaveLength(0);
  });

  it('streams partial replies when stream is true', async () => {
    const { channel, replies } = recordingChannel({ stream: true });
    await post(mountChannels(createAgent({ provider: mockModel(['Hello there']) }), [channel]), '/channels/test', { user: 'a', text: 'hi' });
    expect(replies.some((r) => r.partial)).toBe(true);
    expect(replies.at(-1)).toMatchObject({ text: 'Hello there', result: { finishReason: 'stop' } });
    expect(replies.at(-1)?.partial).toBeUndefined();
  });

  it('an approval pause calls onApproval, and resolveApproval continues and replies', async () => {
    const { tool, execute } = emailTool();
    const agent = createAgent({ provider: mockModel([callEmail, 'Email sent.']), tools: [tool] });
    const onApproval = vi.fn(async () => undefined);
    const { channel, replies } = recordingChannel({ onApproval });
    const handler = mountChannels(agent, [channel]);

    await post(handler, '/channels/test', { user: 'ali', text: 'Email Sam' });

    expect(onApproval).toHaveBeenCalledTimes(1);
    const [ctx] = onApproval.mock.calls[0] as unknown as [ChannelReplyContext];
    expect(ctx.approval).toMatchObject({ toolName: 'send_email', args: { to: 'sam@example.com' } });
    expect(ctx.text).toContain(`approval id: ${ctx.approval?.id}`);
    expect(replies).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();

    await handler.resolveApproval({ id: ctx.approval!.id, approved: true });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ text: 'Email sent.', sessionId: ctx.sessionId, inbound: { replyTo: 'dm:ali' } });
    await expect(handler.resolveApproval({ id: ctx.approval!.id, approved: true })).rejects.toThrow(/No pending channel approval/);
  });

  it('answers an ask_question pause over the approvals route (default onApproval = a text prompt via reply)', async () => {
    const ask = { toolCalls: [{ name: 'ask_question', args: { question: 'Which city?', options: ['Lisbon', 'Porto'] }, id: 'call_q' }] };
    const agent = createAgent({ provider: mockModel([ask, 'Booked Lisbon.']), askQuestion: true });
    const handler = mountChannels(agent, [httpChannel()]);

    const paused = await post(handler, '/channels/http', { sessionKey: 'u1', input: 'Book a trip' });
    const approval = paused.json.approval as { id: string; kind: string };
    expect(paused.json.finishReason).toBe('awaiting-approval');
    expect(approval.kind).toBe('question');
    expect(paused.json.text).toContain('Which city?\n1. Lisbon\n2. Porto');

    expect((await post(handler, `/channels/http/approvals/${approval.id}`, {})).status).toBe(400);
    expect((await post(handler, '/channels/http/approvals/nope', { answer: 'x' })).status).toBe(404);
    const done = await post(handler, `/channels/http/approvals/${approval.id}`, { answer: 'Lisbon' });
    expect(done.json).toMatchObject({ text: 'Booked Lisbon.', finishReason: 'stop', sessionId: paused.json.sessionId });
  });

  it('rejects an invalid channel name and duplicate names', () => {
    expect(() => recordingChannel({ name: 'has space' })).toThrow(/Invalid channel name/);
    const { channel } = recordingChannel();
    expect(() => mountChannels(createAgent({ provider: mockModel([]) }), [channel, channel])).toThrow(/unique/);
  });
});
