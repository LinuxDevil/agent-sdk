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
import { channelSessionId, defineChannel, type Channel, type ChannelContext, type ChannelReplyContext } from './defineChannel';
import { durableStores } from './__fixtures__/durableStores';
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

  describe('ChannelContext.pendingQuestion (M10a)', () => {
    const ask = { toolCalls: [{ name: 'ask_question', args: { question: 'Which city?' }, id: 'call_q' }] };

    /** A custom channel whose next message answers a pending question; `ctx()` is the context its last parse got. */
    function answeringChannel() {
      let context: ChannelContext | undefined;
      const recorded = recordingChannel({
        async parse(req, _respond, ctx) {
          context = ctx;
          const { user, text } = JSON.parse(req.text) as { user: string; text: string };
          const inbound = { sessionKey: user, input: text, replyTo: `dm:${user}` };
          const question = await ctx.pendingQuestion(user);
          return question ? { decision: { id: question, answer: text }, inbound } : inbound;
        },
      });
      return { ...recorded, ctx: () => context! };
    }

    function mount(responses: Parameters<typeof mockModel>[0], stores: ReturnType<typeof durableStores>, tools = [emailTool().tool]) {
      const model = mockModel(responses);
      const agent = createAgent({ provider: model, askQuestion: true, tools, approvalStore: stores.approvalStore });
      const recorded = answeringChannel();
      return { ...recorded, model, agent, handler: mountChannels(agent, [recorded.channel], { store: stores.store }) };
    }

    it('in process: the question the session waits on, handed out once until it is answered', async () => {
      const t = mount([ask, 'Booked Lisbon.'], durableStores());
      await post(t.handler, '/channels/test', { user: 'ali', text: 'Book a trip' });
      const [approval] = await t.agent.approvals.list();
      expect(approval.kind).toBe('question');

      expect(await t.ctx().pendingQuestion('ali')).toBe(approval.id);
      expect(await t.ctx().pendingQuestion('ali')).toBeUndefined(); // claimed by the first caller
      expect(await t.ctx().pendingQuestion('sam')).toBeUndefined(); // another session
    });

    it('after a restart: found from the checkpoint, and the answer is appended to the transcript', async () => {
      const stores = durableStores();
      await post(mount([ask], stores).handler, '/channels/test', { user: 'ali', text: 'Book a trip' });

      const second = mount(['Booked Lisbon.'], stores);
      await post(second.handler, '/channels/test', { user: 'ali', text: 'Lisbon' });

      expect(second.replies.map((r) => r.text)).toEqual(['Booked Lisbon.']);
      const transcript = await stores.transcript();
      for (const text of ['Book a trip', 'Which city?', 'Lisbon', 'Booked Lisbon.']) expect(transcript).toContain(text);
      expect(await second.ctx().pendingQuestion('ali')).toBeUndefined(); // answered
    });

    it('after a restart, two quick messages: the first answers, the second is the next turn', async () => {
      const stores = durableStores();
      await post(mount([ask], stores).handler, '/channels/test', { user: 'ali', text: 'Book a trip' });

      const second = mount(['Booked Lisbon.', 'Noted.'], stores);
      await Promise.all([
        post(second.handler, '/channels/test', { user: 'ali', text: 'Lisbon' }),
        post(second.handler, '/channels/test', { user: 'ali', text: 'And a hotel' }),
      ]);

      expect(second.replies.map((r) => r.text)).toEqual(['Booked Lisbon.', 'Noted.']);
      const userTexts = (second.model.calls[1].messages as Message[]).filter((m) => m.role === 'user').map((m) => m.content);
      expect(userTexts).toEqual(['Book a trip', 'And a hotel']);
    });

    it('undefined for a session with no pending turn, or one waiting on a tool approval (the turn is not run)', async () => {
      const stores = durableStores();
      const first = mount([callEmail], stores);
      await post(first.handler, '/channels/test', { user: 'ali', text: 'Email Sam' });
      expect(await first.ctx().pendingQuestion('ali')).toBeUndefined();

      const second = mount(['Hi Bob.'], stores);
      await post(second.handler, '/channels/test', { user: 'bob', text: 'hi' }); // a normal turn
      expect(second.replies.map((r) => r.text)).toEqual(['Hi Bob.']);
      expect(await second.ctx().pendingQuestion('ali')).toBeUndefined();
      expect(await second.ctx().pendingQuestion('nobody')).toBeUndefined();
      expect(second.model.calls).toHaveLength(1); // Bob's turn only: nothing of Ali's was run
    });
  });

  describe('button decisions are checked against the pending turn (#279)', () => {
    const ask = { toolCalls: [{ name: 'ask_question', args: { question: 'Which city?' }, id: 'call_q' }] };

    /**
     * A channel with buttons: `{ user, text }` is a message, `{ user, click, approved }` a click on
     * approval `click` in `user`'s conversation (the conversation as the click names it).
     */
    function clickingChannel() {
      let context: ChannelContext | undefined;
      const recorded = recordingChannel({
        async parse(req, _respond, ctx) {
          context = ctx;
          const body = JSON.parse(req.text) as { user: string; text?: string; click?: string; approved?: boolean };
          const inbound = { sessionKey: body.user, input: body.text ?? '', replyTo: `dm:${body.user}` };
          return body.click ? { decision: { id: body.click, approved: body.approved ?? true }, inbound, approver: { id: body.user } } : inbound;
        },
      });
      return { ...recorded, ctx: () => context! };
    }

    function mount(responses: Parameters<typeof mockModel>[0], stores: ReturnType<typeof durableStores>, execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`)) {
      const tool = defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
      const model = mockModel(responses);
      const agent = createAgent({ provider: model, tools: [tool], askQuestion: true, approvalStore: stores.approvalStore });
      const onDecision = vi.fn();
      const recorded = clickingChannel();
      return { ...recorded, model, agent, execute, onDecision, handler: mountChannels(agent, [recorded.channel], { store: stores.store, onDecision }) };
    }

    /** Pauses `user`'s conversation on send_email and returns the approval id. */
    async function pauseOn(t: ReturnType<typeof mount>, user: string): Promise<string> {
      const before = new Set((await t.agent.approvals.list()).map((request) => request.id));
      await post(t.handler, '/channels/test', { user, text: 'Email Sam' });
      return (await t.agent.approvals.list()).find((request) => !before.has(request.id))!.id;
    }

    it('after a restart: the continuation of a click is appended to the session transcript', async () => {
      const stores = durableStores();
      const first = mount([callEmail], stores);
      const ali = await pauseOn(first, 'ali');

      const second = mount(['Email sent.', 'You are welcome.'], stores, first.execute);
      expect(await post(second.handler, '/channels/test', { user: 'ali', click: ali })).toMatchObject({ status: 200 });

      expect(first.execute).toHaveBeenCalledTimes(1);
      expect(second.replies.map((r) => [r.inbound.replyTo, r.text])).toEqual([['dm:ali', 'Email sent.']]);
      const transcript = await stores.transcript();
      for (const text of ['Email Sam', '"call_email"', 'sent to sam@example.com', 'Email sent.']) expect(transcript).toContain(text);

      // the conversation has a session now: the next message is its next turn
      await post(second.handler, '/channels/test', { user: 'ali', text: 'Thanks' });
      expect(second.replies.at(-1)?.text).toBe('You are welcome.');
      const userTexts = (second.model.calls[1].messages as Message[]).filter((m) => m.role === 'user').map((m) => m.content);
      expect(userTexts).toEqual(['Email Sam', 'Thanks']);
      expect(JSON.stringify(second.model.calls[1].messages)).toContain('sent to sam@example.com');
    });

    it('after a restart: a click naming a conversation whose turn waits on another approval is refused (404); the right one still decides', async () => {
      const stores = durableStores();
      const first = mount([callEmail, callEmail], stores);
      const ali = await pauseOn(first, 'ali');
      const bob = await pauseOn(first, 'bob');

      const second = mount(['Email sent.'], stores, first.execute);
      const forged = await post(second.handler, '/channels/test', { user: 'bob', click: ali });

      expect(forged).toMatchObject({ status: 404, json: { error: expect.stringContaining(ali) } });
      expect(first.execute).not.toHaveBeenCalled();
      expect(second.onDecision).not.toHaveBeenCalled(); // nothing was decided, so nothing is audited

      expect(await post(second.handler, '/channels/test', { user: 'ali', click: ali })).toMatchObject({ status: 200 });
      expect(first.execute).toHaveBeenCalledTimes(1);
      expect(second.replies.map((r) => [r.inbound.replyTo, r.text])).toEqual([['dm:ali', 'Email sent.']]);
      expect(second.onDecision).toHaveBeenCalledTimes(1);
      expect(bob).not.toBe(ali);
    });

    it('after a restart: a click naming a conversation with nothing pending is refused, and so is a replay', async () => {
      const stores = durableStores();
      const first = mount([callEmail], stores);
      const ali = await pauseOn(first, 'ali');

      const second = mount(['Email sent.', 'never'], stores, first.execute);
      expect(await post(second.handler, '/channels/test', { user: 'carol', click: ali })).toMatchObject({ status: 404 });
      expect(await post(second.handler, '/channels/test', { user: 'ali', click: ali })).toMatchObject({ status: 200 });
      expect(await post(second.handler, '/channels/test', { user: 'ali', click: ali })).toMatchObject({ status: 404 });

      expect(first.execute).toHaveBeenCalledTimes(1);
      expect(second.model.calls).toHaveLength(1);
    });

    it('after a restart: two clicks at once decide once', async () => {
      const stores = durableStores();
      const first = mount([callEmail], stores);
      const ali = await pauseOn(first, 'ali');

      const second = mount(['Email sent.', 'never'], stores, first.execute);
      const statuses = await Promise.all([1, 2].map(async () => (await post(second.handler, '/channels/test', { user: 'ali', click: ali })).status));

      expect(statuses.sort()).toEqual([200, 404]);
      expect(first.execute).toHaveBeenCalledTimes(1);
      expect(second.replies.map((r) => r.text)).toEqual(['Email sent.']);
    });

    it('after a restart: a button decision is not an answer: a click on a pending question is refused', async () => {
      const stores = durableStores();
      const first = mount([ask], stores);
      await post(first.handler, '/channels/test', { user: 'ali', text: 'Book a trip' });
      const [question] = await first.agent.approvals.list();

      const second = mount(['never'], stores);
      expect(await post(second.handler, '/channels/test', { user: 'ali', click: question.id })).toMatchObject({ status: 404 });
      expect(second.model.calls).toHaveLength(0);
    });

    it('in process: a click naming another conversation than the one that paused is refused', async () => {
      const t = mount([callEmail, 'Email sent.'], durableStores());
      const ali = await pauseOn(t, 'ali');

      expect(await post(t.handler, '/channels/test', { user: 'bob', click: ali })).toMatchObject({ status: 404 });
      expect(t.execute).not.toHaveBeenCalled();
      expect(await post(t.handler, '/channels/test', { user: 'ali', click: ali })).toMatchObject({ status: 200 });
      expect(t.execute).toHaveBeenCalledTimes(1);
      expect(t.replies.at(-1)).toMatchObject({ text: 'Email sent.', inbound: { replyTo: 'dm:ali' } });
    });

    it('ctx.approval(id) answers after a restart from the approval store, undefined once decided (#280)', async () => {
      const stores = durableStores();
      const first = mount([callEmail], stores);
      const ali = await pauseOn(first, 'ali');

      const second = mount(['Hi.', 'Email sent.'], stores, first.execute);
      await post(second.handler, '/channels/test', { user: 'bob', text: 'hi' }); // captures the second mount's context
      expect(await second.ctx().approval(ali)).toMatchObject({ id: ali, toolName: 'send_email', args: { to: 'sam@example.com' } });
      expect(await second.ctx().approval('nope')).toBeUndefined();

      await post(second.handler, '/channels/test', { user: 'ali', click: ali });
      expect(await second.ctx().approval(ali)).toBeUndefined();
    });
  });

  it('rejects an invalid channel name and duplicate names', () => {
    expect(() => recordingChannel({ name: 'has space' })).toThrow(/Invalid channel name/);
    const { channel } = recordingChannel();
    expect(() => mountChannels(createAgent({ provider: mockModel([]) }), [channel, channel])).toThrow(/unique/);
  });
});
