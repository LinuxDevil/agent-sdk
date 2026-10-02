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
import { InMemoryApprovalStore } from '../execution/InMemoryApprovalStore';
import { MemorySessionStore } from '../session/sessionStore';
import type { Message } from '../providers';
import { mountChannels, type ChannelsHandler } from './mountChannels';
import { slackChannel } from './slackChannel';

const SECRET = 'slack-signing-secret';
const BOT = 'UBOT';

/** A fake Slack Web API that records each `chat.postMessage` body; `log` interleaves posts and HTTP responses. */
const RESPONSE_URL = 'https://hooks.slack.com/actions/T1/1/x';

function fakeSlack() {
  const log: string[] = [];
  const posts: Array<Record<string, unknown>> = [];
  const callbacks: Array<Record<string, unknown>> = [];
  const state = { failPosts: false };
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (String(url) === RESPONSE_URL) return callbacks.push(body), new Response('ok');
    expect(String(url)).toBe('https://slack.com/api/chat.postMessage');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer xoxb-test');
    posts.push(body);
    log.push('post');
    return new Response(JSON.stringify(state.failPosts ? { ok: false, error: 'channel_not_found' } : { ok: true }));
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, posts, callbacks, state, log };
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

/** A button click of `user` on the approval message of thread 100.1. */
function click(value: string, user = 'U1', action = 'lousho_approve') {
  return {
    type: 'block_actions',
    user: { id: user, username: `name-${user}` },
    team: { id: 'T1' },
    channel: { id: 'C1' },
    message: { text: 'Approve?', ts: '100.9', thread_ts: '100.1' },
    response_url: RESPONSE_URL,
    actions: [{ action_id: action, value }],
  };
}

const emailTool = (execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`)) =>
  defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
const emailCall = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_email' }] };

interface SetupOptions {
  channel?: Partial<Parameters<typeof slackChannel>[0]>;
  mount?: Parameters<typeof mountChannels>[2];
}

function setup(responses: Parameters<typeof mockModel>[0], agentOptions: Partial<Parameters<typeof createAgent>[0]> = {}, extra: SetupOptions = {}) {
  const slack = fakeSlack();
  const model = mockModel(responses);
  const agent = createAgent({ provider: model, ...agentOptions });
  const handler = mountChannels(agent, [slackChannel({ signingSecret: SECRET, botToken: 'xoxb-test', fetch: slack.fetch, ...extra.channel })], extra.mount);
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
    expect([approve.action_id, deny.action_id]).toEqual(['lousho_approve', 'lousho_deny']);
    expect(execute).not.toHaveBeenCalled();

    const approval = click(approve.value);
    expect(await t.send(approval, { form: true, secret: 'wrong' })).toMatchObject({ status: 401 });
    expect(await t.send(approval, { form: true })).toEqual({ status: 200, json: { ok: true } });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(t.posts[1]).toEqual({ channel: 'C1', thread_ts: '100.1', text: 'Email sent.' });
    // the clicked message is replaced by the outcome: no buttons left
    expect(t.callbacks).toEqual([{ replace_original: true, text: 'Approve?\nApproved by <@U1>.' }]);
  });

  /** Runs a turn that pauses on `send_email` and returns the button value of its Approve button. */
  async function pause(t: ReturnType<typeof setup>) {
    await t.send(event('Email Sam'));
    const [prompt] = t.posts as Array<{ blocks: Array<{ elements?: Array<{ value: string }> }> }>;
    return prompt.blocks[1].elements?.[0].value ?? '';
  }

  it('only the user who started the turn may approve by default; others get an ephemeral refusal and it stays pending', async () => {
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] });
    const value = await pause(t);

    await t.send(click(value, 'U2'), { form: true });

    expect(execute).not.toHaveBeenCalled();
    expect(t.callbacks).toEqual([{ response_type: 'ephemeral', replace_original: false, text: 'You are not allowed to approve this request.' }]);
    await t.send(click(value, 'U1', 'lousho_deny'), { form: true });
    expect(t.callbacks[1]).toMatchObject({ replace_original: true, text: 'Approve?\nDenied by <@U1>.' });
  });

  it('approvers as a list of user ids', async () => {
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] }, { channel: { approvers: ['UBOSS'] } });
    const value = await pause(t);

    await t.send(click(value, 'U1'), { form: true }); // the starter is not on the list
    expect(execute).not.toHaveBeenCalled();
    await t.send(click(value, 'UBOSS'), { form: true });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('approvers as a function sees the user and the tool request, and the approver is recorded', async () => {
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const seen: unknown[] = [];
    const approvers = vi.fn(async (user: { id: string }, request: { toolName: string }) => (seen.push([user, request]), user.id === 'UADMIN'));
    const onDecision = vi.fn();
    const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] }, { channel: { approvers }, mount: { onDecision } });
    const value = await pause(t);

    await t.send(click(value, 'U1'), { form: true });
    expect(execute).not.toHaveBeenCalled();
    await t.send(click(value, 'UADMIN'), { form: true });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(seen[1]).toEqual([
      { id: 'UADMIN', name: 'name-UADMIN' },
      { toolName: 'send_email', input: { to: 'sam@example.com' }, sessionId: expect.stringContaining('slack_T1_C1_100_1') },
    ]);
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ approver: { id: 'UADMIN', name: 'name-UADMIN' }, decision: expect.objectContaining({ approved: true }), channel: 'slack' }));
  });

  it('reports a failed reply to onError (never throws) and logs with the channel, session and no token by default', async () => {
    const onError = vi.fn();
    const t = setup(['Hello'], {}, { channel: { onError } });
    t.state.failPosts = true;

    expect(await t.send(event('hi'))).toEqual({ status: 200, json: { ok: true } });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('channel_not_found') }), { channel: 'slack', stage: 'reply', sessionId: expect.stringContaining('slack') });

    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const quiet = setup(['Hello']);
    quiet.state.failPosts = true;
    await quiet.send(event('hi'));
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/^\[slack\] reply failed \(session slack_T1_C1_100_1/);
    expect(String(log.mock.calls[0][0])).not.toContain('xoxb');
    log.mockRestore();
  });

  it('a failed turn goes to onError and the user is told in the thread', async () => {
    const onError = vi.fn();
    const t = setup([{ error: new Error('model down') }], {}, { channel: { onError } });

    expect(await t.send(event('hi'))).toEqual({ status: 200, json: { ok: true } });

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'model down' }), { channel: 'slack', stage: 'turn', sessionId: expect.stringContaining('slack') });
    expect(t.posts).toEqual([{ channel: 'C1', thread_ts: '100.1', text: 'Sorry, that request failed.' }]);
  });

  it('a failed approval continuation goes to onError; a failing notice never throws out of the handler', async () => {
    const onError = vi.fn();
    const t = setup([emailCall, { error: new Error('model down') }], { tools: [emailTool()] }, { channel: { onError } });
    const value = await pause(t);
    t.state.failPosts = true; // neither the continuation nor the failure notice can be delivered

    expect(await t.send(click(value), { form: true })).toEqual({ status: 200, json: { ok: true } });

    expect(onError.mock.calls.map(([, ctx]) => ctx.stage)).toEqual(['approval', 'reply']);
  });

  it('a click still resolves after a restart: a second channel over the same stores', async () => {
    const approvalStore = new InMemoryApprovalStore();
    const store = new MemorySessionStore();
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const first = setup([emailCall], { tools: [emailTool(execute)], approvalStore }, { mount: { store } });
    const value = await pause(first);

    const second = setup(['Email sent.', 'Still here.'], { tools: [emailTool(execute)], approvalStore }, { mount: { store } });
    await second.send(click(value), { form: true });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(second.posts).toEqual([{ channel: 'C1', thread_ts: '100.1', text: 'Email sent.' }]);
    // the thread is known from the session store, not from memory
    await second.send(event('x', { type: 'message', text: 'again', thread_ts: '100.1', ts: '100.5' }));
    expect(second.model.calls).toHaveLength(2);
  });

  it('a direct message to the bot is a session keyed on the DM channel, without a mention', async () => {
    const t = setup(['Hi Ali', 'You are Ali']);
    const dm = (text: string, ts: string) => ({
      type: 'event_callback',
      team_id: 'T1',
      authorizations: [{ user_id: BOT }],
      event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text, ts },
    });

    await t.send(dm('I am Ali', '1.1'));
    await t.send(dm('Who am I?', '2.2'));

    expect(t.posts).toEqual([
      { channel: 'D1', text: 'Hi Ali' },
      { channel: 'D1', text: 'You are Ali' },
    ]);
    expect(t.userTexts(1)).toEqual(['I am Ali', 'Who am I?']);
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
