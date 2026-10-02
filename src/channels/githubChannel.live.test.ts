/**
 * Live test for `githubChannel()` (N11b): one issue-comment turn through the
 * channel with a real model (gpt-4o-mini on OpenRouter), the platform faked.
 *
 * - Replay (default): the model is served from `__cassettes__/github-turn.json`,
 *   so the test costs nothing and runs in the normal test run.
 * - Record: `LOUSHO_RECORD=1` with `OPENROUTER_API_KEY` set (at most 0.05 USD).
 *   Grep the cassette for `sk-or-` and `Authorization` before committing it.
 *
 * Skipped when the cassette is missing and no key is set.
 */
import { createHmac } from 'node:crypto';
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
import { githubChannel } from './githubChannel';

const CASSETTE = path.join(__dirname, '__cassettes__', 'github-turn.json');
const recording = Boolean(process.env.LOUSHO_RECORD);
const runnable = recording ? Boolean(process.env.OPENROUTER_API_KEY) : fs.existsSync(CASSETTE);

describe.skipIf(!runnable)('githubChannel live (N11b)', () => {
  it('a real model answers an issue comment through the channel with one posted comment', async () => {
    const sent: Array<{ url: string; body: string }> = [];
    const fake = (async (url: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: (JSON.parse(String(init?.body)) as { body: string }).body });
      return new Response('{}', { status: 201 });
    }) as typeof fetch;
    const provider = recordReplay(() => resolveProvider('openrouter/openai/gpt-4o-mini'), { cassette: CASSETTE, mode: recording ? 'record' : 'replay' });
    const agent = createAgent({ provider, maxSteps: 1 });
    const handler = mountChannels(agent, [githubChannel({ webhookSecret: 'test-secret', botName: 'my-agent', token: 'test-token', fetch: fake })]);

    const raw = JSON.stringify({
      action: 'created',
      repository: { name: 'widgets', owner: { login: 'acme' } },
      issue: { number: 7 },
      comment: { id: 1, body: '@my-agent reply with one short sentence', author_association: 'MEMBER', user: { login: 'octocat', type: 'User' } },
    });
    const signature = `sha256=${createHmac('sha256', 'test-secret').update(raw).digest('hex')}`;
    const req = Object.assign(Readable.from([Buffer.from(raw)]), {
      method: 'POST',
      url: '/channels/github',
      headers: { 'x-github-event': 'issue_comment', 'x-hub-signature-256': signature },
    });
    const res = { status: 0 };
    const fakeRes = { writeHead: (status: number) => ((res.status = status), fakeRes), end: () => fakeRes };
    await handler(req as unknown as http.IncomingMessage, fakeRes as unknown as http.ServerResponse);

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://api.github.com/repos/acme/widgets/issues/7/comments');
    expect(sent[0].body.replace(/<!--.*?-->/g, '').trim()).toMatch(/\S/);
  });
});
