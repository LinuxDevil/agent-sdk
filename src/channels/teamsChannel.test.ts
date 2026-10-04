/**
 * N11c: `teamsChannel()` - Bot Framework JWT verification (a key pair made in
 * the test), personal chats vs channel mentions, Markdown replies split at
 * 25,000 characters, Adaptive Card approvals bound to their conversation, and a
 * pending question or approval across a restart. A fake Bot Framework service
 * (OpenID metadata, key set, token endpoint, Connector) stands in for Microsoft:
 * no network.
 */
import type * as http from 'node:http';
import { Readable } from 'node:stream';
import { beforeAll, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { InMemoryApprovalStore } from '../execution/InMemoryApprovalStore';
import { MemorySessionStore } from '../session/sessionStore';
import { defineMemory, inMemoryMemory, type MemoryScopeContext } from '../memory';
import type { Message } from '../providers';
import { rsaKey, signToken, nowSec, type PublicSigningKey } from '../auth/__fixtures__/tokens';
import { mountChannels, type ChannelsHandler } from './mountChannels';
import { teamsChannel, type TeamsActivity } from './teamsChannel';
import { durableStores } from './__fixtures__/durableStores';

const APP_ID = '11111111-2222-3333-4444-555555555555';
const APP_PASSWORD = 'SECRET-app-password~1';
const ACCESS_TOKEN = 'SECRET-connector-access-token';
const SERVICE_URL = 'https://smba.example.test/emea/';
const OPENID = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const JWKS = 'https://login.botframework.com/v1/.well-known/keys';
const TOKEN_URL = 'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token';
const ISSUER = 'https://api.botframework.com';

let key: PublicSigningKey;
let otherKey: PublicSigningKey;
beforeAll(async () => {
  [key, otherKey] = await Promise.all([rsaKey(), rsaKey()]);
});

interface Call {
  method: string;
  url: string;
  path: string;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, string>;
  id?: string;
}

/** A fake Bot Framework service: OpenID metadata, key set, token endpoint (counted) and Connector (recorded). */
function fakeTeams() {
  const calls: Call[] = [];
  const urls: string[] = [];
  const tokenRequests: string[] = [];
  let n = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url === OPENID) return Response.json({ issuer: ISSUER, jwks_uri: JWKS });
    if (url === JWKS) return Response.json({ keys: [{ ...key.jwk, kid: 'k1' }] });
    if (url === TOKEN_URL) {
      tokenRequests.push(String(init?.body));
      return Response.json({ access_token: ACCESS_TOKEN, expires_in: 3600 });
    }
    expect(url.startsWith('https://smba.example.test/emea/v3/conversations/')).toBe(true);
    const id = `act-${++n}`;
    const call: Call = { method: String(init?.method), url, path: url.slice('https://smba.example.test/emea'.length), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string>, id };
    calls.push(call);
    return Response.json({ id });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, urls, tokenRequests };
}

interface Auth {
  token?: string | null;
  claims?: Record<string, unknown>;
  signer?: PublicSigningKey;
}

/** The headers of a request signed like the Bot Framework (`token: null` omits them). */
async function authHeaders(auth: Auth, serviceUrl: string): Promise<Record<string, string>> {
  if (auth.token === null) return {};
  const token = auth.token ?? (await signToken(auth.signer ?? key, { iss: ISSUER, aud: APP_ID, serviceurl: serviceUrl, ...auth.claims }, { kid: 'k1' }));
  return { authorization: `Bearer ${token}` };
}

async function send(handler: ChannelsHandler, activity: unknown, auth: Auth = {}, raw?: string) {
  const body = raw ?? JSON.stringify(activity);
  const serviceUrl = (activity as { serviceUrl?: string })?.serviceUrl ?? SERVICE_URL;
  const headers = await authHeaders(auth, serviceUrl);
  const req = Object.assign(Readable.from([Buffer.from(body)]), { method: 'POST', url: '/channels/teams', headers });
  const res = { status: 0, json: {} as Record<string, unknown> };
  const fakeRes = {
    writeHead: (status: number) => ((res.status = status), fakeRes),
    end: (text?: string) => ((res.json = JSON.parse(text ?? '{}') as Record<string, unknown>), fakeRes),
  };
  await handler(req as unknown as http.IncomingMessage, fakeRes as unknown as http.ServerResponse);
  return res;
}

const BOT = { id: '28:bot-app-id', name: 'Lousho' };
const SAM = { id: '29:sam-teams-id', name: 'Sam', aadObjectId: 'aad-sam' };
const PERSONAL = { id: 'a:personal-1', conversationType: 'personal' as const, tenantId: 'tenant-1' };
const CHANNEL = { id: '19:abc@thread.tacv2;messageid=1700000000', conversationType: 'channel' as const, tenantId: 'tenant-1' };

let activityId = 0;

function activity(extra: Partial<TeamsActivity> = {}): TeamsActivity {
  return { type: 'message', id: `in-${++activityId}`, serviceUrl: SERVICE_URL, channelId: 'msteams', from: SAM, recipient: BOT, conversation: PERSONAL, ...extra };
}

const mention = (id = BOT.id, text = '<at>Lousho</at>') => ({ type: 'mention', mentioned: { id }, text });

/** The submit of an Adaptive Card button: a message with `value` and no text. */
function click(data: unknown, extra: Partial<TeamsActivity> = {}): TeamsActivity {
  return activity({ value: data, replyToId: 'act-1', ...extra });
}

interface SetupOptions {
  channel?: Partial<Parameters<typeof teamsChannel>[0]>;
  mount?: Parameters<typeof mountChannels>[2];
}

const emailTool = (execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`)) =>
  defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
const emailCall = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_email' }] };
const ask = { toolCalls: [{ name: 'ask_question', args: { question: 'Which city?' }, id: 'call_q' }] };

function setup(responses: Parameters<typeof mockModel>[0], agentOptions: Partial<Parameters<typeof createAgent>[0]> = {}, extra: SetupOptions = {}) {
  const teams = fakeTeams();
  const model = mockModel(responses);
  const agent = createAgent({ provider: model, ...agentOptions });
  const channel = teamsChannel({ appId: APP_ID, appPassword: APP_PASSWORD, fetch: teams.fetch, ...extra.channel });
  const handler = mountChannels(agent, [channel], extra.mount);
  const userTexts = (call: number) => (model.calls[call].messages as Message[]).filter((m) => m.role === 'user').map((m) => m.content);
  return { ...teams, model, userTexts, send: (payload: unknown, auth?: Auth, raw?: string) => send(handler, payload, auth, raw) };
}

type Setup = ReturnType<typeof setup>;

/** The Adaptive Card of a recorded Connector call. */
const cardOf = (call: Call) => call.body.attachments[0].content as { version: string; body: Array<Record<string, any>>; actions?: Array<{ type: string; title: string; data: Record<string, string> }> }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Runs a message that pauses on `send_email`; returns the Approve button's `data`. */
async function pause(t: Setup, extra: Partial<TeamsActivity> = {}) {
  await t.send(activity({ text: 'Email Sam', ...extra }));
  return cardOf(t.calls[0]).actions?.[0].data as Record<string, string>;
}

describe('teamsChannel (N11c)', () => {
  it('needs an app id and password', () => {
    expect(() => teamsChannel({ appId: '', appPassword: APP_PASSWORD })).toThrow(/appId/);
    expect(() => teamsChannel({ appId: APP_ID, appPassword: '' })).toThrow(/appPassword/);
    expect(() => teamsChannel({ appId: APP_ID, appPassword: APP_PASSWORD, tenantId: 'x/../y' })).toThrow(/tenantId/);
  });

  describe('inbound token', () => {
    const body = () => activity({ text: 'hi' });

    it('answers 401 and runs nothing for a missing, wrong-audience, wrong-issuer, expired, badly signed or non-bearer token', async () => {
      const t = setup(['never']);

      expect((await t.send(body(), { token: null })).status).toBe(401);
      expect((await t.send(body(), { token: 'not.a.jwt' })).status).toBe(401);
      expect((await t.send(body(), { claims: { aud: 'someone-elses-app' } })).status).toBe(401);
      expect((await t.send(body(), { claims: { iss: 'https://sts.windows.net/tenant/' } })).status).toBe(401);
      expect((await t.send(body(), { claims: { exp: nowSec() - 3600 } })).status).toBe(401);
      expect((await t.send(body(), { signer: otherKey })).status).toBe(401); // right kid, wrong key
      expect((await t.send(body(), { claims: { serviceurl: 'https://evil.example.test/' } })).status).toBe(401);
      expect((await t.send(body(), { claims: { serviceurl: undefined } })).status).toBe(401);

      expect(t.model.calls).toHaveLength(0);
      expect(t.calls).toHaveLength(0);
    });

    it('a valid token for another service URL cannot be replayed to make the bot post elsewhere', async () => {
      const t = setup(['never']);
      const replayed = activity({ text: 'hi', serviceUrl: 'https://evil.example.test/' });

      const res = await t.send(replayed, { claims: { serviceurl: SERVICE_URL } });

      expect(res.status).toBe(401);
      expect(t.model.calls).toHaveLength(0);
      expect(t.urls.some((url) => url.includes('evil'))).toBe(false);
    });

    it('takes the keys from the fixed OpenID metadata, never from the token', async () => {
      const t = setup(['ok']);
      const token = await signToken(key, { iss: ISSUER, aud: APP_ID, serviceurl: SERVICE_URL }, { kid: 'k1', jku: 'https://evil.example.test/keys', jwk: otherKey.jwk, x5u: 'https://evil.example.test/x5' });

      expect((await t.send(body(), { token })).status).toBe(200);

      expect(t.urls.filter((url) => !url.includes('smba.'))).toEqual([OPENID, JWKS, TOKEN_URL]);
    });

    it('does not parse the body before the token is valid', async () => {
      const t = setup(['never']);

      expect((await t.send(null, { token: null }, '{ not json')).status).toBe(401);
      expect((await t.send(null, { token: 'x.y.z' }, '{ not json')).status).toBe(401);
      expect((await t.send(null, {}, '{ not json')).status).toBe(401); // valid token, but no service URL to bind it to

      expect(t.model.calls).toHaveLength(0);
    });

    it('accepts the service URL with or without a trailing slash', async () => {
      const t = setup(['one']);

      expect((await t.send(activity({ text: 'hi' }), { claims: { serviceurl: SERVICE_URL.replace(/\/$/, '') } })).status).toBe(200);
      expect(t.model.calls).toHaveLength(1);
    });
  });

  it('acknowledges with 200, runs a personal message and replies in that conversation to that message, as Markdown', async () => {
    const t = setup(['Hi **Sam**', 'You are Sam']);

    expect(await t.send(activity({ id: 'm1', text: 'I am Sam' }))).toEqual({ status: 200, json: {} });
    await t.send(activity({ id: 'm2', text: 'Who am I?' }));

    expect(t.calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', '/v3/conversations/a%3Apersonal-1/activities/m1', { type: 'message', text: 'Hi **Sam**', textFormat: 'markdown', replyToId: 'm1' }],
      ['POST', '/v3/conversations/a%3Apersonal-1/activities/m2', { type: 'message', text: 'You are Sam', textFormat: 'markdown', replyToId: 'm2' }],
    ]);
    expect(t.userTexts(1)).toEqual(['I am Sam', 'Who am I?']);
  });

  it('runs the turn with the sender as its principal, which a memory scope sees (N10a)', async () => {
    const scopes: MemoryScopeContext[] = [];
    const notes = defineMemory({ name: 'notes', scope: (ctx) => (scopes.push(ctx), ctx.principal && `teams:${ctx.principal.id}`), provider: inMemoryMemory() });
    const t = setup(['Hi', 'Hi again'], { memory: [notes] });

    await t.send(activity({ text: 'hello' }));
    await t.send(activity({ text: 'again', from: { id: '29:no-aad' } }));

    expect(scopes[0].principal).toEqual({ id: 'aad-sam', type: 'user', authenticator: 'teams', issuer: 'tenant-1' });
    expect(scopes[1].principal).toEqual({ id: '29:no-aad', type: 'user', authenticator: 'teams', issuer: 'tenant-1' });
  });

  describe('channels and group chats', () => {
    it('ignores a message that does not mention the bot, or mentions someone else', async () => {
      const t = setup(['never']);

      await t.send(activity({ conversation: CHANNEL, text: 'lunch anyone?' }));
      await t.send(activity({ conversation: { ...CHANNEL, conversationType: 'groupChat' }, text: '<at>Joe</at> lunch?', entities: [mention('29:joe', '<at>Joe</at>')] }));
      await t.send(activity({ conversation: { id: 'a:no-type' }, text: 'hello' })); // not known to be personal

      expect(t.model.calls).toHaveLength(0);
      expect(t.calls).toHaveLength(0);
    });

    it('a mention runs the turn with the <at> text stripped, in the conversation of the channel thread', async () => {
      const t = setup(['In the thread']);

      await t.send(activity({ id: 'm9', conversation: CHANNEL, text: '<at>Lousho</at> what is 2+2?', entities: [mention()] }));

      expect(t.userTexts(0)).toEqual(['what is 2+2?']);
      expect(t.calls.map((c) => [c.path, c.body.text])).toEqual([[`/v3/conversations/${encodeURIComponent(CHANNEL.id)}/activities/m9`, 'In the thread']]);
    });

    it('a group chat works the same, and a channel thread is its own session', async () => {
      const t = setup(['one', 'two', 'three']);
      const talk = (conversation: TeamsActivity['conversation'], text: string) => t.send(activity({ conversation, text: `<at>Lousho</at> ${text}`, entities: [mention()] }));

      await talk({ ...CHANNEL, id: '19:group@thread.v2', conversationType: 'groupChat' }, 'first');
      await talk(CHANNEL, 'second');
      await talk(CHANNEL, 'third');

      expect(t.userTexts(0)).toEqual(['first']);
      expect(t.userTexts(1)).toEqual(['second']);
      expect(t.userTexts(2)).toEqual(['second', 'third']);
    });
  });

  it('ignores updates that are not messages, and the bot\'s own messages', async () => {
    const t = setup(['never']);

    await t.send(activity({ type: 'conversationUpdate', text: 'hello' }));
    await t.send(activity({ type: 'typing' }));
    await t.send(activity({ type: 'invoke', value: { lousho: 'approve', ref: ':x', conv: PERSONAL.id } }));
    await t.send(activity({ from: BOT, text: 'I said this' }));
    await t.send(activity({ conversation: CHANNEL, from: BOT, text: '<at>Lousho</at> echo', entities: [mention()] }));
    await t.send(activity({ text: '' }));
    await t.send(activity({ conversation: CHANNEL, text: '<at>Lousho</at>', entities: [mention()] })); // nothing left to say

    expect(t.model.calls).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });

  it('fetches the outbound token once, with the app credentials, and reuses it', async () => {
    const t = setup(['one', 'two']);

    await t.send(activity({ text: 'a' }));
    await t.send(activity({ text: 'b' }));

    expect(t.tokenRequests).toHaveLength(1);
    const form = new URLSearchParams(t.tokenRequests[0]);
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'client_credentials', client_id: APP_ID, client_secret: APP_PASSWORD, scope: 'https://api.botframework.com/.default' });
    expect(t.calls.map((c) => c.headers.authorization)).toEqual([`Bearer ${ACCESS_TOKEN}`, `Bearer ${ACCESS_TOKEN}`]);
  });

  it('a single-tenant bot asks its own tenant for the token', async () => {
    const inner = fakeTeams();
    const seen: string[] = [];
    const wrapped = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (seen.push(String(input)), inner.fetch(String(input).replace('/contoso.example/', '/botframework.com/'), init))) as unknown as typeof fetch;
    const t = setup(['ok'], {}, { channel: { tenantId: 'contoso.example', fetch: wrapped } });

    await t.send(activity({ text: 'hi' }));

    expect(seen).toContain('https://login.microsoftonline.com/contoso.example/oauth2/v2.0/token');
  });

  it('splits a 60,000-character reply into messages of at most 25,000 characters at line breaks', async () => {
    const long = `${'a'.repeat(20_000)}\n${'b'.repeat(20_000)}\n${'c'.repeat(20_000)}`;
    const t = setup([long]);

    await t.send(activity({ text: 'write a lot' }));

    expect(t.calls).toHaveLength(3);
    expect(t.calls.every((c) => c.body.text.length <= 25_000)).toBe(true);
    expect(t.calls.map((c) => c.body.text).join('\n')).toBe(long);
  });

  describe('approvals', () => {
    it('posts an Adaptive Card with Approve and Deny buttons that name the conversation', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] });

      await t.send(activity({ id: 'm1', text: 'Email Sam' }));

      const attachment = t.calls[0].body.attachments[0];
      expect(attachment.contentType).toBe('application/vnd.microsoft.card.adaptive');
      const body = cardOf(t.calls[0]);
      expect(body.version).toBe('1.4');
      expect(body.body[0]).toMatchObject({ type: 'TextBlock', text: 'Approve `send_email`?' });
      expect(body.body[1]).toMatchObject({ type: 'TextBlock', fontType: 'Monospace', text: expect.stringContaining('sam@example.com') });
      expect(body.actions?.map((a) => [a.type, a.title, a.data.lousho])).toEqual([
        ['Action.Submit', 'Approve', 'approve'],
        ['Action.Submit', 'Deny', 'deny'],
      ]);
      expect(body.actions?.[0].data).toEqual({ lousho: 'approve', ref: expect.stringMatching(/^29%3Asam-teams-id:/), conv: PERSONAL.id });
      expect(t.calls[0].path).toBe('/v3/conversations/a%3Apersonal-1/activities/m1');
      expect(execute).not.toHaveBeenCalled();
    });

    it('truncates long arguments in the card', async () => {
      const t = setup([{ toolCalls: [{ name: 'send_email', args: { to: 'x'.repeat(5000) }, id: 'c' }] }], { tools: [emailTool()] });

      await t.send(activity({ text: 'Email' }));

      const shown = cardOf(t.calls[0]).body[1].text as string;
      expect(shown.length).toBeLessThan(2100);
      expect(shown).toContain('(truncated)');
    });

    it('a submit by the starter resumes the session and updates the card to "Approved by <name>."', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] });
      const approve = await pause(t);

      expect(await t.send(click(approve))).toEqual({ status: 200, json: {} });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(t.calls.slice(1).map((c) => [c.method, c.path])).toEqual([
        ['PUT', '/v3/conversations/a%3Apersonal-1/activities/act-1'],
        ['POST', '/v3/conversations/a%3Apersonal-1/activities/act-1'],
      ]);
      const updated = t.calls[1].body;
      expect(updated).toMatchObject({ type: 'message', id: 'act-1' });
      expect(cardOf(t.calls[1]).body).toEqual([{ type: 'TextBlock', text: 'Approved by Sam.', wrap: true }]);
      expect(cardOf(t.calls[1]).actions).toBeUndefined();
      expect(t.calls[2].body).toMatchObject({ text: 'Email sent.' });
    });

    it('Deny declines the call', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, 'Okay, not sent.'], { tools: [emailTool(execute)] });
      const approve = await pause(t);

      await t.send(click({ ...approve, lousho: 'deny' }));

      expect(execute).not.toHaveBeenCalled();
      expect(cardOf(t.calls[1]).body[0].text).toBe('Denied by Sam.');
      expect(t.calls.at(-1)?.body.text).toBe('Okay, not sent.');
    });

    it('a submit by another user is refused and the approval stays pending', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] });
      const approve = await pause(t);

      await t.send(click(approve, { from: { id: '29:someone-else', name: 'Eve' } }));

      expect(t.calls.slice(1).map((c) => c.body.text)).toEqual(['You are not allowed to approve this request.']);
      expect(execute).not.toHaveBeenCalled();
      await t.send(click(approve));
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('approvers as a list of Teams user ids, and the approver is recorded', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const onDecision = vi.fn();
      const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] }, { channel: { approvers: ['29:boss'] }, mount: { onDecision } });
      const approve = await pause(t);

      await t.send(click(approve)); // the starter is not in the list
      expect(execute).not.toHaveBeenCalled();
      await t.send(click(approve, { from: { id: '29:boss', name: 'Boss' } }));

      expect(execute).toHaveBeenCalledTimes(1);
      expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ approver: expect.objectContaining({ id: '29:boss' }), channel: 'teams' }));
    });

    it('a click in a channel thread (a message with a value and no mention) is a decision', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] });
      const approve = await pause(t, { conversation: CHANNEL, text: '<at>Lousho</at> Email Sam', entities: [mention()] });
      expect(approve.conv).toBe(CHANNEL.id);

      await t.send(click(approve, { conversation: CHANNEL }));

      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('a card reference copied into another conversation decides nothing', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] });
      const approve = await pause(t);

      await t.send(click(approve, { conversation: { id: 'a:personal-2', conversationType: 'personal' } }));
      await t.send(click({ lousho: 'approve', ref: approve.ref }, { conversation: { id: 'a:personal-2', conversationType: 'personal' } }));

      expect(execute).not.toHaveBeenCalled();
      expect(t.calls).toHaveLength(1);
      await t.send(click(approve)); // in its own conversation it still works
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('two pending approvals of one user stay scoped to their conversations', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, emailCall, 'Done.'], { tools: [emailTool(execute)] });
      const a = await pause(t);
      await t.send(activity({ conversation: { id: 'a:personal-2', conversationType: 'personal' }, text: 'Email Sam too' }));
      const b = cardOf(t.calls[1]).actions?.[0].data as Record<string, string>;
      expect(a.ref).not.toBe(b.ref);

      await t.send(click(a, { conversation: { id: 'a:personal-2', conversationType: 'personal' } })); // A's card in B's conversation
      expect(execute).not.toHaveBeenCalled();
      await t.send(click(b, { conversation: { id: 'a:personal-2', conversationType: 'personal' }, replyToId: 'act-2' }));
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('a replayed card does not decide a later approval', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, 'First sent.', emailCall, 'Second sent.'], { tools: [emailTool(execute)] }, { channel: { onError: vi.fn() } });
      const first = await pause(t);
      await t.send(click(first));
      await t.send(activity({ text: 'Email Sam again' }));
      const second = cardOf(t.calls.filter((c) => c.body.attachments?.length && !c.body.id).at(-1) as Call).actions?.[0].data as Record<string, string>;
      expect(second.ref).not.toBe(first.ref);
      expect(execute).toHaveBeenCalledTimes(1);

      await t.send(click(first)); // the old card again

      expect(execute).toHaveBeenCalledTimes(1);
      await t.send(click(second));
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it('a decision still resolves on a second channel instance over the same stores (restart)', async () => {
      const approvalStore = new InMemoryApprovalStore();
      const store = new MemorySessionStore();
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const approve = await pause(setup([emailCall], { tools: [emailTool(execute)], approvalStore }, { mount: { store } }));

      const second = setup(['Email sent.'], { tools: [emailTool(execute)], approvalStore }, { mount: { store } });
      await second.send(click(approve));

      expect(execute).toHaveBeenCalledTimes(1);
      expect(second.calls.at(-1)?.body).toMatchObject({ text: 'Email sent.' });
    });

    it('a used card replayed after a restart produces no second continuation', async () => {
      const approvalStore = new InMemoryApprovalStore();
      const store = new MemorySessionStore();
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const first = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)], approvalStore }, { mount: { store } });
      const approve = await pause(first);
      await first.send(click(approve));
      expect(execute).toHaveBeenCalledTimes(1);

      const onError = vi.fn();
      const second = setup(['never'], { tools: [emailTool(execute)], approvalStore }, { mount: { store }, channel: { onError } });
      await second.send(click(approve));

      expect(execute).toHaveBeenCalledTimes(1);
      expect(second.model.calls).toHaveLength(0);
    });
  });

  it('posts an ask_question as text and takes the next message as the answer', async () => {
    const t = setup([ask, 'Booked Lisbon.'], { askQuestion: true });

    await t.send(activity({ text: 'Book a trip' }));
    expect(t.calls[0].body.text).toContain('Which city?');

    await t.send(activity({ text: 'Lisbon' }));

    expect(t.calls[1].body).toMatchObject({ text: 'Booked Lisbon.' });
    expect(JSON.stringify(t.model.calls[1].messages)).toContain('Lisbon');
  });

  describe('after a restart: a second channel over the same durable stores (M10a)', () => {
    it('a pending ask_question survives a restart', async () => {
      const stores = durableStores();
      const agentOptions = { askQuestion: true, approvalStore: stores.approvalStore };
      const first = setup([ask], agentOptions, { mount: { store: stores.store } });
      await first.send(activity({ text: 'Book a trip' }));

      const second = setup(['Booked Lisbon.'], agentOptions, { mount: { store: stores.store } });
      await second.send(activity({ text: 'Lisbon' }));

      expect(second.calls.map((c) => c.body.text)).toEqual(['Booked Lisbon.']);
      expect(JSON.stringify(second.model.calls[0].messages)).toContain('Lisbon');
    });

    it('a card press after a restart is appended to the transcript, and the next message continues the session (#279)', async () => {
      const stores = durableStores();
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const agentOptions = { tools: [emailTool(execute)], approvalStore: stores.approvalStore };
      const approve = await pause(setup([emailCall], agentOptions, { mount: { store: stores.store } }));

      const second = setup(['Email sent.', 'You are welcome.'], agentOptions, { mount: { store: stores.store } });
      await second.send(click(approve));
      expect(execute).toHaveBeenCalledTimes(1);
      for (const text of ['"call_email"', 'sent to sam@example.com', 'Email sent.']) expect(await stores.transcript()).toContain(text);

      await second.send(activity({ text: 'Thanks' }));
      expect(second.calls.at(-1)?.body).toMatchObject({ text: 'You are welcome.' });
      expect(JSON.stringify(second.model.calls[1].messages)).toContain('sent to sam@example.com');
    });
  });

  describe('failures', () => {
    it('a failed Connector call goes to onError without the app password or the access token', async () => {
      const onError = vi.fn();
      const inner = fakeTeams();
      const failing = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes('/v3/conversations/') ? new Response(`denied ${APP_PASSWORD} ${ACCESS_TOKEN}`, { status: 403 }) : inner.fetch(input, init)
      ) as unknown as typeof fetch;
      const t = setup(['Hello'], {}, { channel: { onError, fetch: failing } });

      expect((await t.send(activity({ text: 'hi' }))).status).toBe(200);

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'LOUSHO_CHANNEL_REQUEST_FAILED', message: expect.stringContaining('send activity failed: 403') }), { channel: 'teams', stage: 'reply', sessionId: expect.stringContaining('teams') });
      const error = onError.mock.calls[0][0] as Error;
      const shown = JSON.stringify(error, Object.getOwnPropertyNames(error));
      expect(shown).not.toContain(APP_PASSWORD);
      expect(shown).not.toContain(ACCESS_TOKEN);
    });

    it('a failed token request goes to onError by status only, and a network error whose message carries the secret does not leak it', async () => {
      const onError = vi.fn();
      const inner = fakeTeams();
      let mode: 'status' | 'throw' = 'status';
      const failing = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) !== TOKEN_URL) return inner.fetch(input, init);
        if (mode === 'throw') throw new Error(`connect ECONNREFUSED ${String(init?.body)}`);
        return new Response(JSON.stringify({ error: 'invalid_client', error_description: `bad ${APP_PASSWORD}` }), { status: 401 });
      }) as unknown as typeof fetch;
      const t = setup(['Hello', 'Again'], {}, { channel: { onError, fetch: failing } });

      await t.send(activity({ text: 'hi' }));
      mode = 'throw';
      await t.send(activity({ text: 'again' }));

      expect(onError.mock.calls[0][0].message).toContain('teamsChannel: the token request failed: 401');
      expect(onError.mock.calls[1][0].message).toContain('the request did not complete');
      for (const [error] of onError.mock.calls as Array<[Error]>) expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('SECRET-app-password');
      expect(t.calls).toHaveLength(0);
    });

    it('sends nothing to a service URL that is not https, even when the token names it', async () => {
      const onError = vi.fn();
      const t = setup(['Hello'], {}, { channel: { onError } });

      const res = await t.send(activity({ text: 'hi', serviceUrl: 'http://smba.example.test/' }));

      expect(res.status).toBe(200);
      expect(t.urls.some((url) => url.startsWith('http://'))).toBe(false);
      expect(onError.mock.calls[0][0].message).toContain('https');
    });

    it('the default error report never prints the app password or the token', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const failing = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes('/v3/conversations/') ? new Response('{}', { status: 500 }) : fakeTeams().fetch(input, init)
      ) as unknown as typeof fetch;
      const t = setup(['Hello'], {}, { channel: { fetch: failing } });

      await t.send(activity({ text: 'hi' }));

      expect(spy).toHaveBeenCalled();
      const printed = spy.mock.calls.flat().join(' ');
      expect(printed).not.toContain('SECRET-app-password');
      expect(printed).not.toContain('SECRET-connector-access-token');
      spy.mockRestore();
    });

    it('a failed turn goes to onError and the user is told in the conversation', async () => {
      const onError = vi.fn();
      const t = setup([{ error: new Error('model down') }], {}, { channel: { onError } });

      await t.send(activity({ text: 'hi' }));

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'model down' }), { channel: 'teams', stage: 'turn', sessionId: expect.stringContaining('teams') });
      expect(t.calls.map((c) => c.body.text)).toEqual(['Sorry, that request failed.']);
    });
  });
});
