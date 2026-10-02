/**
 * Live test for `teamsChannel()` (N11c): one personal-chat turn through the
 * channel with a real model (gpt-4o-mini on OpenRouter), Microsoft faked (a key
 * pair made in the test signs the Bot Framework token).
 *
 * - Replay (default): the model is served from `__cassettes__/teams-turn.json`,
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
import { rsaKey, signToken } from '../auth/__fixtures__/tokens';
import { mountChannels } from './mountChannels';
import { teamsChannel } from './teamsChannel';

const CASSETTE = path.join(__dirname, '__cassettes__', 'teams-turn.json');
const recording = Boolean(process.env.LOUSHO_RECORD);
const runnable = recording ? Boolean(process.env.OPENROUTER_API_KEY) : fs.existsSync(CASSETTE);

describe.skipIf(!runnable)('teamsChannel live (N11c)', () => {
  it('a real model answers a personal message through the channel as one Connector reply', async () => {
    const key = await rsaKey();
    const appId = 'live-app-id';
    const serviceUrl = 'https://smba.example.test/emea/';
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/openidconfiguration')) return Response.json({ issuer: 'https://api.botframework.com', jwks_uri: 'https://login.botframework.com/v1/.well-known/keys' });
      if (url.endsWith('/keys')) return Response.json({ keys: [{ ...key.jwk, kid: 'k1' }] });
      if (url.includes('/oauth2/v2.0/token')) return Response.json({ access_token: 'test-access-token', expires_in: 3600 });
      sent.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ id: 'act-1' });
    }) as typeof fetch;
    const provider = recordReplay(() => resolveProvider('openrouter/openai/gpt-4o-mini'), { cassette: CASSETTE, mode: recording ? 'record' : 'replay' });
    const agent = createAgent({ provider, maxSteps: 1 });
    const handler = mountChannels(agent, [teamsChannel({ appId, appPassword: 'test-password', fetch: fake })]);

    const activity = {
      type: 'message',
      id: 'in-1',
      serviceUrl,
      channelId: 'msteams',
      from: { id: '29:sam', name: 'Sam' },
      recipient: { id: '28:bot' },
      conversation: { id: 'a:1', conversationType: 'personal' },
      text: 'Reply with one short sentence.',
    };
    const token = await signToken(key, { iss: 'https://api.botframework.com', aud: appId, serviceurl: serviceUrl }, { kid: 'k1' });
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(activity))]), { method: 'POST', url: '/channels/teams', headers: { authorization: `Bearer ${token}` } });
    const res = { status: 0 };
    const fakeRes = { writeHead: (status: number) => ((res.status = status), fakeRes), end: () => fakeRes };
    await handler(req as unknown as http.IncomingMessage, fakeRes as unknown as http.ServerResponse);

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('/v3/conversations/a%3A1/activities/in-1');
    expect(sent[0].body).toMatchObject({ type: 'message', text: expect.stringMatching(/\S/) });
  });
});
