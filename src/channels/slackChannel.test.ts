/**
 * LOU-P5: `slackChannel()` - signatures, the url_verification handshake, a
 * session per thread, retry dedupe, in-thread replies and approvals as buttons.
 * A fake `fetch` stands in for the Slack Web API: no network.
 */
import { createHmac } from 'node:crypto';
import type * as http from 'node:http';
import { Readable } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import type { Message } from '../providers';
import { mountChannels, type ChannelsHandler } from './mountChannels';
import { slackChannel } from './slackChannel';

const SECRET = 'slack-signing-secret';
const BOT = 'UBOT';

/** A fake Slack Web API that records each `chat.postMessage` body; `log` interleaves posts and HTTP responses. */
function fakeSlack() {
  const log: string[] = [];
  const posts: Array<Record<string, unknown>> = [];
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe('https://slack.com/api/chat.postMessage');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer xoxb-test');
    posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    log.push('post');
    return new Response(JSON.stringify({ ok: true }));
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, posts, log };
}

interface SendOptions {
  form?: boolean;
  headers?: Record<string, string>;
  timestamp?: number;
  secret?: string;
}

/** Posts a signed Slack request (JSON event, or form-encoded interactivity payload) to `handler`. */
async function send(handler: ChannelsHandler, log: string[], payload: unknown, options: SendOptions = {}) {
  const body = options.form ? `payload=${encodeURIComponent(JSON.stringify(payload))}` : JSON.stringify(payload);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', options.secret ?? SECRET).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  const headers = {
    'content-type': options.form ? 'application/x-www-form-urlencoded' : 'application/json',
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': signature,
    ...options.headers,
  };
  const req = Object.assign(Readable.from([Buffer.from(body)]), { method: 'POST', url: '/channels/slack', headers });
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

function event(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'event_callback',
    team_id: 'T1',
    authorizations: [{ user_id: BOT }],
    event: { type: 'app_mention', channel: 'C1', user: 'U1', text: `<@${BOT}> ${text}`, ts: '100.1', ...extra },
  };
}

function setup(responses: Parameters<typeof mockModel>[0], agentOptions: Partial<Parameters<typeof createAgent>[0]> = {}) {
  const slack = fakeSlack();
  const model = mockModel(responses);
  const agent = createAgent({ provider: model, ...agentOptions });
  const handler = mountChannels(agent, [slackChannel({ signingSecret: SECRET, botToken: 'xoxb-test', fetch: slack.fetch })]);
  const userTexts = (call: number) => (model.calls[call].messages as Message[]).filter((m) => m.role === 'user').map((m) => m.content);
  return { ...slack, model, handler, userTexts, send: (payload: unknown, options?: SendOptions) => send(handler, slack.log, payload, options) };
}

describe('slackChannel (LOU-P5)', () => {
  it('answers the url_verification challenge and rejects bad or stale signatures', async () => {
    const t = setup(['never']);

    expect(await t.send({ type: 'url_verification', challenge: 'abc' })).toEqual({ status: 200, json: { challenge: 'abc' } });
    expect((await t.send(event('hi'), { secret: 'wrong' })).status).toBe(401);
    expect((await t.send(event('hi'), { timestamp: Math.floor(Date.now() / 1000) - 600 })).status).toBe(401);
    expect((await t.send(event('hi'), { headers: { 'x-slack-signature': 'v0=zz' } })).status).toBe(401);
    expect(t.model.calls).toHaveLength(0);
    expect(() => slackChannel({ signingSecret: '', botToken: 'x' })).toThrow(/signingSecret/);
  });

  it('acks first, then replies in the thread; follow-ups in the thread continue the same session', async () => {
    const t = setup(['Hi Ali', 'You are Ali', 'Other thread']);

    expect(await t.send(event('I am Ali'))).toEqual({ status: 200, json: { ok: true } });
    await t.send(event('Who am I?', { type: 'message', text: 'Who am I?', ts: '100.5', thread_ts: '100.1' }));
    await t.send(event('Who am I?', { ts: '200.1' }));

    expect(t.log.slice(0, 2)).toEqual(['ack', 'post']);
    expect(t.posts).toEqual([
      { channel: 'C1', thread_ts: '100.1', text: 'Hi Ali' },
      { channel: 'C1', thread_ts: '100.1', text: 'You are Ali' },
      { channel: 'C1', thread_ts: '200.1', text: 'Other thread' },
    ]);
    expect(t.userTexts(1)).toEqual(['I am Ali', 'Who am I?']);
    expect(t.userTexts(2)).toEqual(['Who am I?']);
  });

  it('skips retries, bot messages, mention echoes and threads it was never mentioned in', async () => {
    const t = setup(['Once']);

    await t.send(event('hi'));
    expect(await t.send(event('hi'), { headers: { 'x-slack-retry-num': '1' } })).toEqual({ status: 200, json: { ok: true } });
    await t.send(event('x', { type: 'message', text: `<@${BOT}> hi`, ts: '100.1' }));
    await t.send(event('x', { type: 'message', text: 'from me', user: BOT, thread_ts: '100.1', ts: '100.2' }));
    await t.send(event('x', { type: 'message', text: 'beep', bot_id: 'B1', thread_ts: '100.1', ts: '100.3' }));
    await t.send(event('x', { type: 'message', text: 'unrelated', thread_ts: '300.1', ts: '300.2' }));

    expect(t.model.calls).toHaveLength(1);
    expect(t.posts).toHaveLength(1);
  });

  it('posts Approve / Deny buttons and resumes the session from the button click', async () => {
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const tool = defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
    const call = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_email' }] };
    const t = setup([call, 'Email sent.'], { tools: [tool] });

    await t.send(event('Email Sam'));

    const [prompt] = t.posts as Array<{ thread_ts: string; blocks: Array<{ elements?: Array<{ action_id: string; value: string }> }> }>;
    expect(prompt.thread_ts).toBe('100.1');
    const [approve, deny] = prompt.blocks[1].elements ?? [];
    expect([approve.action_id, deny.action_id]).toEqual(['loushy_approve', 'loushy_deny']);
    expect(execute).not.toHaveBeenCalled();

    const click = { type: 'block_actions', actions: [{ action_id: approve.action_id, value: approve.value }] };
    expect(await t.send(click, { form: true, secret: 'wrong' })).toMatchObject({ status: 401 });
    expect(await t.send(click, { form: true })).toEqual({ status: 200, json: { ok: true } });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(t.posts[1]).toEqual({ channel: 'C1', thread_ts: '100.1', text: 'Email sent.' });
  });

  it('posts an ask_question as text and takes the next thread message as the answer', async () => {
    const ask = { toolCalls: [{ name: 'ask_question', args: { question: 'Which city?' }, id: 'call_q' }] };
    const t = setup([ask, 'Booked Lisbon.'], { askQuestion: true });

    await t.send(event('Book a trip'));
    expect(t.posts[0]).toMatchObject({ thread_ts: '100.1', text: expect.stringContaining('Which city?') });

    await t.send(event('x', { type: 'message', text: 'Lisbon', thread_ts: '100.1', ts: '100.2' }));

    expect(t.posts[1]).toEqual({ channel: 'C1', thread_ts: '100.1', text: 'Booked Lisbon.' });
    expect(JSON.stringify(t.model.calls[1].messages)).toContain('Lisbon');
  });
});
