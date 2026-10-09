/**
 * The `/channels` routes of `mountChannels()` on the Fetch API
 * (mountFetchChannels, #298): `POST <basePath>/<name>` and
 * `POST <basePath>/<name>/approvals/:id`, Request in, Response out, so a
 * Worker host can serve the same channels.
 */
import { describe, it, expect, vi } from 'vitest';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { defineChannel, type Channel, type ChannelReplyContext } from './defineChannel';
import { httpChannel } from './httpChannel';
import { mountFetchChannels } from './fetchChannels';

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

const post = (path: string, body: unknown) => new Request(`http://worker${path}`, { method: 'POST', body: JSON.stringify(body) });

describe('mountFetchChannels (#298)', () => {
  it('resolves undefined for requests outside its routes', async () => {
    const handler = mountFetchChannels(createAgent({ provider: mockModel(['hi']) }), [httpChannel()]);
    expect(await handler(new Request('http://worker/health'))).toBeUndefined();
    expect(await handler(new Request('http://worker/channels/unknown', { method: 'POST', body: '{}' }))).toBeUndefined();
    expect(await handler(new Request('http://worker/channels/http', { method: 'GET' }))).toBeUndefined();
  });

  it('runs a turn through the channel and replies, acknowledging with the channel answer', async () => {
    const { channel, replies } = recordingChannel();
    const handler = mountFetchChannels(createAgent({ provider: mockModel(['Hello there']) }), [channel]);
    const response = await handler(post('/channels/test', { user: 'a', text: 'hi' }));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true });
    expect(replies.map((r) => r.text)).toEqual(['Hello there']);
    expect(replies[0].sessionId).toMatch(/^test_a-/);
  });

  it('a 500 does not leak the internal error message; the detail goes to onError (Eve CH-F6)', async () => {
    const secret = 'connect ECONNREFUSED postgres://admin:hunter2@10.0.0.1:5432/prod';
    const onError = vi.fn();
    const { channel } = recordingChannel({
      onError,
      verify: async () => {
        throw new Error(secret);
      },
    });
    const handler = mountFetchChannels(createAgent({ provider: mockModel(['hi']) }), [channel]);
    const response = await handler(post('/channels/test', { user: 'a', text: 'hi' }));
    expect(response?.status).toBe(500);
    const text = await response!.text();
    expect(text).not.toContain('hunter2');
    expect(JSON.parse(text)).toEqual({ error: 'The request failed. The server log has the details.' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: secret }), expect.objectContaining({ channel: 'test' }));
  });

  it('keeps the 400 for a body that is not JSON (Eve CH-F6)', async () => {
    const { channel } = recordingChannel();
    const handler = mountFetchChannels(createAgent({ provider: mockModel(['hi']) }), [channel]);
    const response = await handler(new Request('http://worker/channels/test', { method: 'POST', body: '{nope' }));
    expect(response?.status).toBe(400);
  });

  it('answers 401 when the channel verify fails', async () => {
    const { channel } = recordingChannel({ verify: async () => false });
    const handler = mountFetchChannels(createAgent({ provider: mockModel(['hi']) }), [channel]);
    const response = await handler(post('/channels/test', { user: 'a', text: 'hi' }));
    expect(response?.status).toBe(401);
  });

  it('answers the httpChannel JSON API like mountChannels does', async () => {
    const handler = mountFetchChannels(createAgent({ provider: mockModel(['pong']) }), [httpChannel()]);
    const response = await handler(post('/channels/http', { sessionKey: 'u1', input: 'ping' }));
    expect(response?.status).toBe(200);
    expect((await response?.json()) as { sessionId: string; text: string }).toMatchObject({ sessionId: expect.stringMatching(/^http_u1-/), text: 'pong' });
  });

  it('returns an early respond while the turn runs under ctx.waitUntil', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const { channel } = recordingChannel({
      async parse(_req, respond) {
        respond(202, { accepted: true });
        await gate;
        return { sessionKey: 'u', input: 'hi', replyTo: null };
      },
    });
    const handler = mountFetchChannels(createAgent({ provider: mockModel(['done']) }), [channel]);
    const waited: Promise<unknown>[] = [];
    const response = await handler(post('/channels/test', {}), { waitUntil: (p) => waited.push(p) });
    expect(response?.status).toBe(202);
    expect(await response?.json()).toEqual({ accepted: true });
    expect(waited).toHaveLength(1);
    finish();
    await waited[0];
  });

  it('awaits the turn when no waitUntil is given, then returns the early respond, and warns once (Eve CH-F4)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { channel, replies } = recordingChannel({
      async parse(_req, respond) {
        respond(202, { accepted: true });
        return { sessionKey: 'u', input: 'hi', replyTo: null };
      },
    });
    const handler = mountFetchChannels(createAgent({ provider: mockModel(['done', 'again']) }), [channel]);
    const response = await handler(post('/channels/test', {}));
    expect(await response?.json()).toEqual({ accepted: true });
    expect(replies.map((r) => r.text)).toEqual(['done']);
    await handler(post('/channels/test', {}));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/waitUntil/);
    warn.mockRestore();
  });

  it('returns the early respond at once with the waitUntil option, for hosts that pass no ctx (Eve CH-F4)', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { channel, replies } = recordingChannel({
      async parse(_req, respond) {
        respond(200, { ok: true });
        return { sessionKey: 'u', input: 'hi', replyTo: null };
      },
      async reply(ctx) {
        await gate; // a slow turn: the ack must not wait for it
        replies.push(ctx);
      },
    });
    const waited: Promise<unknown>[] = [];
    const handler = mountFetchChannels(createAgent({ provider: mockModel(['done']) }), [channel], { waitUntil: (p) => waited.push(p) });
    const response = await handler(post('/channels/test', {}));
    expect(response?.status).toBe(200);
    expect(waited).toHaveLength(1);
    expect(replies).toHaveLength(0);
    finish();
    await waited[0];
    expect(replies.map((r) => r.text)).toEqual(['done']);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('answers 400 for a bad JSON body and for an approvals body without a decision', async () => {
    const handler = mountFetchChannels(createAgent({ provider: mockModel(['hi']) }), [httpChannel()]);
    const badJson = await handler(new Request('http://worker/channels/http', { method: 'POST', body: '{nope' }));
    expect(badJson?.status).toBe(400);
    const noDecision = await handler(post('/channels/http/approvals/x', { unrelated: 1 }));
    expect(noDecision?.status).toBe(400);
  });

  it('answers 404 for an approval id no channel turn paused on', async () => {
    const handler = mountFetchChannels(createAgent({ provider: mockModel(['hi']) }), [httpChannel()]);
    const response = await handler(post('/channels/http/approvals/none', { approved: true }));
    expect(response?.status).toBe(404);
  });
});
