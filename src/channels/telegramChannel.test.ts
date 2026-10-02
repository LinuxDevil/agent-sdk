/**
 * N11a: `telegramChannel()` - the webhook secret token, private chats vs groups
 * and forum topics, plain-text replies split at 4096 characters, approvals as
 * inline keyboards, and a pending question across a restart. A fake `fetch`
 * stands in for the Bot API: no network.
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
import { telegramChannel, type TelegramMessage, type TelegramUpdate } from './telegramChannel';
import { secretsEqual } from './channelSupport';
import { durableStores } from './__fixtures__/durableStores';

const TOKEN = '123456:SECRET-bot-token';
const SECRET = 'webhook-secret_1';

interface Call {
  method: string;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A fake Bot API that records each call (`https://api.telegram.org/bot<token>/<method>`). */
function fakeTelegram() {
  const log: string[] = [];
  const calls: Call[] = [];
  let id = 100;
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const prefix = `https://api.telegram.org/bot${TOKEN}/`;
    expect(String(url).startsWith(prefix)).toBe(true);
    const method = String(url).slice(prefix.length);
    calls.push({ method, body: JSON.parse(String(init?.body)) });
    log.push(method);
    return new Response(JSON.stringify({ ok: true, result: { message_id: ++id } }));
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, log };
}

/** Posts `payload` to `handler` with the secret token header (or `secret`; `null` omits it). */
async function send(handler: ChannelsHandler, payload: unknown, secret: string | null = SECRET) {
  const headers = secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret };
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), { method: 'POST', url: '/channels/telegram', headers });
  const res = { status: 0, json: {} as Record<string, unknown> };
  const fakeRes = {
    writeHead: (status: number) => ((res.status = status), fakeRes),
    end: (text?: string) => ((res.json = JSON.parse(text ?? '{}') as Record<string, unknown>), fakeRes),
  };
  await handler(req as unknown as http.IncomingMessage, fakeRes as unknown as http.ServerResponse);
  return res;
}

let updateId = 0;

/** A text message from user 7 (default: a private chat 42, message 11). */
function message(text: string, extra: Partial<TelegramMessage> = {}): TelegramUpdate {
  return { update_id: ++updateId, message: { message_id: 11, from: { id: 7, first_name: 'Sam', username: 'sam' }, chat: { id: 42, type: 'private' }, text, ...extra } };
}

const group = (text: string, extra: Partial<TelegramMessage> = {}) => message(text, { chat: { id: -1001, type: 'supergroup' }, ...extra });

/** A tap of `user` (default: 7) on the keyboard of the approval message in chat 42. */
function tap(data: string, user = 7, extra: Partial<TelegramMessage> = {}): TelegramUpdate {
  return {
    update_id: ++updateId,
    callback_query: { id: `cb-${updateId}`, from: { id: user, first_name: `User ${user}`, username: `user${user}` }, data, message: { message_id: 101, chat: { id: 42, type: 'private' }, text: 'Approve?', ...extra } },
  };
}

interface SetupOptions {
  channel?: Partial<Parameters<typeof telegramChannel>[0]>;
  mount?: Parameters<typeof mountChannels>[2];
}

const emailTool = (execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`)) =>
  defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
const emailCall = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_email' }] };
const ask = { toolCalls: [{ name: 'ask_question', args: { question: 'Which city?' }, id: 'call_q' }] };

function setup(responses: Parameters<typeof mockModel>[0], agentOptions: Partial<Parameters<typeof createAgent>[0]> = {}, extra: SetupOptions = {}) {
  const telegram = fakeTelegram();
  const model = mockModel(responses);
  const agent = createAgent({ provider: model, ...agentOptions });
  const channel = telegramChannel({ botToken: TOKEN, secretToken: SECRET, botUsername: 'lousho_bot', fetch: telegram.fetch, ...extra.channel });
  const handler = mountChannels(agent, [channel], extra.mount);
  const userTexts = (call: number) => (model.calls[call].messages as Message[]).filter((m) => m.role === 'user').map((m) => m.content);
  return { ...telegram, model, userTexts, send: (payload: unknown, secret?: string | null) => send(handler, payload, secret) };
}

/** Runs a message that pauses on `send_email` and returns the Approve button's `callback_data`. */
async function pause(t: ReturnType<typeof setup>) {
  await t.send(message('Email Sam'));
  return t.calls[0].body.reply_markup.inline_keyboard[0][0].callback_data as string;
}

describe('secretsEqual', () => {
  it('compares equal, different and different-length secrets', async () => {
    expect(await secretsEqual('abc', 'abc')).toBe(true);
    expect(await secretsEqual('abc', 'abd')).toBe(false);
    expect(await secretsEqual('abc', 'abcd')).toBe(false);
    expect(await secretsEqual('', 'abc')).toBe(false);
  });
});

describe('telegramChannel (N11a)', () => {
  it('rejects a missing or wrong secret token with 401 and runs nothing', async () => {
    const t = setup(['never']);

    expect((await t.send(message('hi'), null)).status).toBe(401);
    expect((await t.send(message('hi'), 'wrong')).status).toBe(401);
    expect((await t.send(message('hi'), `${SECRET}x`)).status).toBe(401);

    expect(t.model.calls).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
    expect(() => telegramChannel({ botToken: '', secretToken: SECRET })).toThrow(/botToken/);
    expect(() => telegramChannel({ botToken: TOKEN, secretToken: '' })).toThrow(/secretToken/);
  });

  it('acknowledges with 200, runs a private message as a turn and replies as plain text to the chat', async () => {
    const t = setup(['Hi Sam', 'You are Sam']);

    expect(await t.send(message('I am Sam'))).toEqual({ status: 200, json: { ok: true } });
    await t.send(message('Who am I?', { message_id: 12 }));

    expect(t.calls).toEqual([
      { method: 'sendMessage', body: { chat_id: 42, reply_parameters: { message_id: 11, allow_sending_without_reply: true }, text: 'Hi Sam' } },
      { method: 'sendMessage', body: { chat_id: 42, reply_parameters: { message_id: 12, allow_sending_without_reply: true }, text: 'You are Sam' } },
    ]);
    expect(t.calls.every((c) => !('parse_mode' in c.body))).toBe(true);
    expect(t.userTexts(1)).toEqual(['I am Sam', 'Who am I?']);
  });

  it('uses a caption as the text and ignores updates without text', async () => {
    const t = setup(['Nice photo']);

    await t.send(message('', { text: undefined, caption: 'Look at this' }));
    await t.send(message('', { text: undefined }));
    await t.send({ update_id: 1, edited_message: { message_id: 1 } });

    expect(t.userTexts(0)).toEqual(['Look at this']);
    expect(t.calls).toHaveLength(1);
  });

  it('a forum topic is its own session and the reply stays in the topic', async () => {
    const t = setup(['In topic 5', 'In topic 6']);
    const topic = (id: number) => ({ chat: { id: -1001, type: 'supergroup' }, is_topic_message: true, message_thread_id: id });

    await t.send(group('/ask hi', topic(5)));
    await t.send(group('/ask hi', topic(6)));

    expect(t.calls.map((c) => [c.body.chat_id, c.body.message_thread_id, c.body.text])).toEqual([
      [-1001, 5, 'In topic 5'],
      [-1001, 6, 'In topic 6'],
    ]);
    expect(t.userTexts(1)).toEqual(['hi']);
  });

  describe('groups', () => {
    it('ignores a message without a command, mention or reply to the bot', async () => {
      const t = setup(['never']);

      await t.send(group('lunch anyone?'));
      await t.send(group('/askew nothing'));
      await t.send(group('/ask@other_bot hi'));
      await t.send(group('hello @someone_else'));
      await t.send(group('lunch', { reply_to_message: { from: { id: 8, is_bot: false } } }));

      expect(t.model.calls).toHaveLength(0);
      expect(t.calls).toHaveLength(0);
    });

    it('/ask@bot and @bot run a turn with the command and the mention stripped', async () => {
      const t = setup(['one', 'two', 'three', 'four']);

      await t.send(group('/ask@lousho_bot what is 2+2?'));
      await t.send(group('@lousho_bot what is 3+3?', { message_id: 12 }));
      await t.send(group('/ask plain command', { message_id: 13 }));
      await t.send(group('what about that @Lousho_Bot', { message_id: 14 }));

      expect(t.userTexts(3)).toEqual(['what is 2+2?', 'what is 3+3?', 'plain command', 'what about that']);
      expect(t.calls.map((c) => c.body.chat_id)).toEqual([-1001, -1001, -1001, -1001]);
    });

    it('a reply to one of the bot\'s own messages wakes it', async () => {
      const t = setup(['answer']);

      await t.send(group('and then?', { reply_to_message: { from: { id: 99, is_bot: true, username: 'lousho_bot' } } }));
      await t.send(group('and then?', { reply_to_message: { from: { id: 98, is_bot: true, username: 'other_bot' } } }));

      expect(t.userTexts(0)).toEqual(['and then?']);
      expect(t.model.calls).toHaveLength(1);
    });
  });

  it('ignores messages from bots', async () => {
    const t = setup(['never']);

    await t.send(message('hello', { from: { id: 9, is_bot: true, username: 'echo_bot' } }));
    await t.send(group('/ask hi', { from: { id: 9, is_bot: true } }));

    expect(t.model.calls).toHaveLength(0);
  });

  it('splits a 9000-character reply into 3 messages at line breaks, each at most 4096 characters', async () => {
    const long = `${'a'.repeat(3000)}\n${'b'.repeat(3000)}\n${'c'.repeat(3000)}`;
    const t = setup([long]);

    await t.send(message('write a lot'));

    expect(t.calls).toHaveLength(3);
    expect(t.calls.every((c) => c.body.text.length <= 4096)).toBe(true);
    expect(t.calls.map((c) => c.body.text).join('\n')).toBe(long);
    expect(t.calls[0].body.reply_parameters).toBeDefined();
    expect(t.calls[1].body.reply_parameters).toBeUndefined();
  });

  it('posts an inline keyboard and a tap by the starter resumes the session and edits the message', async () => {
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] });

    await t.send(message('Email Sam'));

    const keyboard = t.calls[0].body.reply_markup.inline_keyboard[0] as Array<{ text: string; callback_data: string }>;
    expect(t.calls[0].body.text).toContain('send_email');
    expect(keyboard.map((b) => b.text)).toEqual(['Approve', 'Deny']);
    expect(keyboard[0].callback_data).toMatch(/^a:7:/);
    expect(keyboard[1].callback_data).toMatch(/^d:7:/);
    expect(keyboard.every((b) => new TextEncoder().encode(b.callback_data).length <= 64)).toBe(true);
    expect(execute).not.toHaveBeenCalled();

    expect((await t.send(tap(keyboard[0].callback_data), 'wrong')).status).toBe(401);
    expect(await t.send(tap(keyboard[0].callback_data))).toEqual({ status: 200, json: { ok: true } });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(t.calls.slice(1).map((c) => c.method)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
    expect(t.calls[2].body).toEqual({ chat_id: 42, message_id: 101, text: 'Approve?\nApproved by @user7.' });
    expect(t.calls[3].body).toMatchObject({ chat_id: 42, text: 'Email sent.' });
  });

  it('Deny declines the call', async () => {
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const t = setup([emailCall, 'Okay, not sent.'], { tools: [emailTool(execute)] });
    const approve = await pause(t);

    await t.send(tap(approve.replace(/^a:/, 'd:')));

    expect(execute).not.toHaveBeenCalled();
    expect(t.calls.find((c) => c.method === 'editMessageText')?.body.text).toBe('Approve?\nDenied by @user7.');
    expect(t.calls.at(-1)?.body.text).toBe('Okay, not sent.');
  });

  it('only the starter may approve by default; another user gets an alert and it stays pending', async () => {
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] });
    const approve = await pause(t);

    await t.send(tap(approve, 8));

    expect(t.calls.slice(1)).toEqual([{ method: 'answerCallbackQuery', body: { callback_query_id: expect.any(String), text: 'You are not allowed to approve this request.', show_alert: true } }]);
    expect(execute).not.toHaveBeenCalled();
    await t.send(tap(approve, 7));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('approvers as a list of user ids, and the approver is recorded', async () => {
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const onDecision = vi.fn();
    const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] }, { channel: { approvers: ['9'] }, mount: { onDecision } });
    const approve = await pause(t);

    await t.send(tap(approve, 7));
    expect(execute).not.toHaveBeenCalled();
    await t.send(tap(approve, 9));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ approver: expect.objectContaining({ id: '9' }), channel: 'telegram' }));
  });

  it('a value too long for 64 bytes drops the starter, so only a list or function of approvers can approve', async () => {
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const big = { from: { id: '1234567890123456789012345678901234567890' as unknown as number, first_name: 'Sam' } }; // not reachable with real ids (at most 52 bits)
    const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] }, { channel: { approvers: ['7'] } });

    await t.send(message('Email Sam', big));
    const data = t.calls[0].body.reply_markup.inline_keyboard[0][0].callback_data as string;

    expect(data).toMatch(/^a::/);
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    await t.send(tap(data, 7));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a replayed tap does not decide a later approval', async () => {
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const onError = vi.fn();
    const t = setup([emailCall, 'First sent.', emailCall, 'Second sent.'], { tools: [emailTool(execute)] }, { channel: { onError } });
    const first = await pause(t);
    await t.send(tap(first));
    await t.send(message('Email Sam again', { message_id: 12 }));
    const second = t.calls.at(-1)?.body.reply_markup.inline_keyboard[0][0].callback_data as string;
    expect(second).not.toBe(first);
    expect(execute).toHaveBeenCalledTimes(1);

    await t.send(tap(first)); // the old tap again

    expect(execute).toHaveBeenCalledTimes(1);
    await t.send(tap(second));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('a tap still resolves on a second channel instance over the same stores (restart)', async () => {
    const approvalStore = new InMemoryApprovalStore();
    const store = new MemorySessionStore();
    const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
    const approve = await pause(setup([emailCall], { tools: [emailTool(execute)], approvalStore }, { mount: { store } }));

    const second = setup(['Email sent.'], { tools: [emailTool(execute)], approvalStore }, { mount: { store } });
    await second.send(tap(approve));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(second.calls.at(-1)?.body).toMatchObject({ chat_id: 42, text: 'Email sent.' });
  });

  it('posts an ask_question with force_reply and takes the next message as the answer', async () => {
    const t = setup([ask, 'Booked Lisbon.'], { askQuestion: true });

    await t.send(message('Book a trip'));
    expect(t.calls[0].body).toMatchObject({ text: expect.stringContaining('Which city?'), reply_markup: { force_reply: true } });

    await t.send(message('Lisbon', { message_id: 12 }));

    expect(t.calls[1].body).toMatchObject({ chat_id: 42, text: 'Booked Lisbon.' });
    expect(JSON.stringify(t.model.calls[1].messages)).toContain('Lisbon');
  });

  describe('after a restart: a second channel over the same durable stores (M10a)', () => {
    it('a pending ask_question survives a restart', async () => {
      const stores = durableStores();
      const agentOptions = { askQuestion: true, approvalStore: stores.approvalStore };
      const first = setup([ask], agentOptions, { mount: { store: stores.store } });
      await first.send(message('Book a trip'));
      expect(first.calls[0].body.text).toContain('Which city?');

      const second = setup(['Booked Lisbon.', 'You are welcome.'], agentOptions, { mount: { store: stores.store } });
      await second.send(message('Lisbon', { message_id: 12 }));

      expect(second.calls).toEqual([{ method: 'sendMessage', body: expect.objectContaining({ chat_id: 42, text: 'Booked Lisbon.' }) }]);
      expect(second.model.calls).toHaveLength(1);
      expect(JSON.stringify(second.model.calls[0].messages)).toContain('Lisbon');
      const transcript = await stores.transcript();
      for (const text of ['Book a trip', 'Which city?', 'Lisbon', 'Booked Lisbon.']) expect(transcript).toContain(text);

      // answered: the next message is a new turn of the same session
      await second.send(message('Thanks', { message_id: 13 }));
      expect(second.calls[1].body).toMatchObject({ text: 'You are welcome.' });
      expect(second.userTexts(1)).toEqual(['Book a trip', 'Thanks']);
    });

    it('a chat with no pending question still starts a normal turn', async () => {
      const stores = durableStores();
      await setup(['Hello.'], { approvalStore: stores.approvalStore }, { mount: { store: stores.store } }).send(message('hi'));

      const second = setup(['Still here.'], { approvalStore: stores.approvalStore }, { mount: { store: stores.store } });
      await second.send(message('again', { message_id: 12 }));

      expect(second.calls[0].body).toMatchObject({ text: 'Still here.' });
      expect(second.userTexts(0)).toEqual(['hi', 'again']);
    });

    it('a plain message does not answer a pending tool approval; the tap still does', async () => {
      const stores = durableStores();
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const agentOptions = { tools: [emailTool(execute)], approvalStore: stores.approvalStore };
      const approve = await pause(setup([emailCall], agentOptions, { mount: { store: stores.store } }));

      const second = setup(['Email sent.'], agentOptions, { mount: { store: stores.store } });
      await second.send(message('yes', { message_id: 12 }));
      expect(second.model.calls).toHaveLength(0);
      expect(execute).not.toHaveBeenCalled();
      expect(second.calls[0].body.text).toBe('Sorry, that request failed.'); // the session waits on the tap

      await second.send(tap(approve));
      expect(execute).toHaveBeenCalledTimes(1);
      expect(second.calls.at(-1)?.body.text).toBe('Email sent.');
    });
  });

  it('a failed sendMessage goes to onError and the bot token is not in the logged message', async () => {
    const onError = vi.fn();
    const failing = vi.fn(async () => new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }), { status: 400 })) as unknown as typeof globalThis.fetch;
    const t = setup(['Hello'], {}, { channel: { onError, fetch: failing } });

    expect((await t.send(message('hi'))).json).toEqual({ ok: true });

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'LOUSHO_CHANNEL_REQUEST_FAILED', message: expect.stringContaining('sendMessage') }), { channel: 'telegram', stage: 'reply', sessionId: expect.stringContaining('telegram') });
    expect(JSON.stringify(onError.mock.calls[0][0], Object.getOwnPropertyNames(onError.mock.calls[0][0]))).not.toContain(TOKEN);
  });

  it('a network error whose message carries the URL does not leak the token either', async () => {
    const onError = vi.fn();
    const throwing = vi.fn(async (url: RequestInfo | URL) => {
      throw new Error(`connect ECONNREFUSED ${String(url)}`);
    }) as unknown as typeof globalThis.fetch;
    const t = setup(['Hello'], {}, { channel: { onError, fetch: throwing } });

    await t.send(message('hi'));

    const error = onError.mock.calls[0][0] as Error;
    expect(error.message).toContain('sendMessage');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('SECRET-bot-token');
  });

  it('a failed turn goes to onError and the user is told in the chat', async () => {
    const onError = vi.fn();
    const t = setup([{ error: new Error('model down') }], {}, { channel: { onError } });

    await t.send(message('hi'));

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'model down' }), { channel: 'telegram', stage: 'turn', sessionId: expect.stringContaining('telegram') });
    expect(t.calls.map((c) => c.body.text)).toEqual(['Sorry, that request failed.']);
  });

  it('the default error report never prints the token', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof globalThis.fetch;
    const t = setup(['Hello'], {}, { channel: { fetch: failing } });

    await t.send(message('hi'));

    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.flat().join(' ')).not.toContain('SECRET-bot-token');
    spy.mockRestore();
  });
});
