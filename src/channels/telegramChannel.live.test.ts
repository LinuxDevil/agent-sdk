/**
 * Live test for `telegramChannel()` (N11a): one private-chat turn through the
 * channel with a real model (gpt-4o-mini on OpenRouter), the platform faked.
 *
 * - Replay (default): the model is served from `__cassettes__/telegram-turn.json`,
 *   so the test costs nothing and runs in the normal test run.
 * - Record: `LOUSHO_RECORD=1` with `OPENROUTER_API_KEY` set (at most 0.05 USD).
 *   Grep the cassette for `sk-or-` and `Authorization` before committing it.
 *
 * Skipped when the cassette is missing and no key is set.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as http from 'node:http';
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { createAgent } from '../createAgent';
import '../providers'; // registers the real providers (openrouter)
import { resolveProvider } from '../providers/resolveProvider';
import { recordReplay } from '../testing';
import { mountChannels } from './mountChannels';
import { telegramChannel } from './telegramChannel';

const CASSETTE = path.join(__dirname, '__cassettes__', 'telegram-turn.json');
const recording = Boolean(process.env.LOUSHO_RECORD);
const runnable = recording ? Boolean(process.env.OPENROUTER_API_KEY) : fs.existsSync(CASSETTE);

describe.skipIf(!runnable)('telegramChannel live (N11a)', () => {
  it('a real model answers a private message through the channel as plain text', async () => {
    const sent: Array<{ method: string; body: Record<string, unknown> }> = [];
    const fake = (async (url: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ method: String(url).split('/').pop() ?? '', body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }) as typeof fetch;
    const provider = recordReplay(() => resolveProvider('openrouter/openai/gpt-4o-mini'), { cassette: CASSETTE, mode: recording ? 'record' : 'replay' });
    const agent = createAgent({ provider, maxSteps: 1 });
    const handler = mountChannels(agent, [telegramChannel({ botToken: 'test-token', secretToken: 'test-secret', fetch: fake })]);

    const update = { update_id: 1, message: { message_id: 5, from: { id: 7, first_name: 'Sam' }, chat: { id: 42, type: 'private' }, text: 'Reply with one short sentence.' } };
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(update))]), {
      method: 'POST',
      url: '/channels/telegram',
      headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
    });
    const res = { status: 0 };
    const fakeRes = { writeHead: (status: number) => ((res.status = status), fakeRes), end: () => fakeRes };
    await handler(req as unknown as http.IncomingMessage, fakeRes as unknown as http.ServerResponse);

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('sendMessage');
    expect(sent[0].body).toMatchObject({ chat_id: 42, text: expect.stringMatching(/\S/) });
    expect(sent[0].body).not.toHaveProperty('parse_mode');
  });
});
