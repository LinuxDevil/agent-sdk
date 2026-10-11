/**
 * Cross-site requests, JSON bodies, `Host` allowlists and the default session
 * owner on the session routes (`createRouteHandler()`, `serveFetch()`).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { memoryStore } from '../storage/agentStore';
import { createRouteHandler, type RouteHandlerOptions } from './routeHandler';
import { serveFetch } from './fetchRoutes';
import { MAX_SESSION_OWNERS, sessionOwnership } from './requestGuard';
import type { AuthFn } from '../auth';

const deploy = defineTool({ name: 'deploy', description: 'Deploys', input: z.object({}), needsApproval: true, execute: () => 'shipped' });

/** A cookie-style auth: `cookie: user=<name>` is that user. */
const cookieAuth: AuthFn = async (request) => {
  const name = /(?:^|;\s*)user=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1];
  return name ? { id: name, type: 'user', authenticator: 'custom' } : null;
};

function routes(replies: Parameters<typeof mockModel>[0], options: RouteHandlerOptions = {}) {
  const model = mockModel(replies);
  const agent = createAgent({ provider: model, tools: [deploy], store: memoryStore() });
  return { agent, model, ...createRouteHandler(agent, { auth: [cookieAuth], ...options }) };
}

const post = (path: string, body: string, headers: Record<string, string>) =>
  new Request(`http://app.test/api/agent${path}`, { method: 'POST', headers: { host: 'app.test', ...headers }, body });

const json = (value: unknown) => JSON.stringify(value);
const alice = { cookie: 'user=alice' };
const asJson = { 'content-type': 'application/json' };

describe('cross-site requests (CSRF)', () => {
  it('refuses a POST from another origin carrying the user\'s cookie, and runs nothing', async () => {
    const { handler, model } = routes(['Hi.']);
    const forged = await handler(post('/chat', json({ sessionId: 's1', input: 'hi' }), { ...alice, ...asJson, origin: 'https://evil.example' }));
    expect(forged.status).toBe(403);
    expect(await forged.json()).toMatchObject({ code: 'LOUSHO_REQUEST_FORBIDDEN' });
    const marked = await handler(post('/chat', json({ sessionId: 's1', input: 'hi' }), { ...alice, ...asJson, 'sec-fetch-site': 'cross-site' }));
    expect(marked.status).toBe(403);
    const opaque = await handler(post('/chat', json({ sessionId: 's1', input: 'hi' }), { ...alice, ...asJson, origin: 'null' }));
    expect(opaque.status).toBe(403);
    expect(model.calls).toHaveLength(0);
  });

  it('refuses a cross-site approval decision and the hook routes too', async () => {
    const { handler } = routes([{ toolCalls: [{ name: 'deploy', id: 'c1' }] }, 'Deployed.']);
    const paused = await (await handler(post('/chat', json({ sessionId: 's2', input: 'ship' }), { ...alice, ...asJson }))).text();
    const approvalId = /"approvalId":"([^"]+)"/.exec(paused)?.[1];
    expect(approvalId).toBeDefined();
    const evil = { ...alice, ...asJson, origin: 'https://evil.example' };
    expect((await handler(post(`/chat/s2/approvals/${approvalId}`, json({ approved: true }), evil))).status).toBe(403);
    expect((await handler(post(`/approvals/${approvalId}`, json({ approved: true }), evil))).status).toBe(403);
    expect((await handler(post('', json({ input: 'hi' }), evil))).status).toBe(403);
  });

  it('accepts the server\'s own origin, a proxied one, a listed one, and callers that send no Origin', async () => {
    const { handler } = routes(['a', 'b', 'c', 'd'], { allowedOrigins: ['https://app.example'] });
    expect((await handler(post('/chat', json({ sessionId: 'o1', input: 'hi' }), { ...alice, ...asJson, origin: 'http://app.test', 'sec-fetch-site': 'same-origin' }))).status).toBe(200);
    expect((await handler(post('/chat', json({ sessionId: 'o2', input: 'hi' }), { ...alice, ...asJson, host: 'internal:3000', 'x-forwarded-host': 'agent.example', origin: 'https://agent.example' }))).status).toBe(200);
    expect((await handler(post('/chat', json({ sessionId: 'o3', input: 'hi' }), { ...alice, ...asJson, origin: 'https://app.example', 'sec-fetch-site': 'cross-site' }))).status).toBe(200);
    expect((await handler(post('/chat', json({ sessionId: 'o4', input: 'hi' }), { ...alice, ...asJson }))).status).toBe(200);
  });

  it('matches a proxied host with its default port, the standard Forwarded header, and allowedOrigins with a trailing slash', async () => {
    const { handler } = routes(['a', 'b', 'c', 'd'], { allowedOrigins: ['https://App.example/'] });
    const proxied = { ...alice, ...asJson, host: 'internal:3000' };
    expect((await handler(post('/chat', json({ sessionId: 'p1', input: 'hi' }), { ...proxied, 'x-forwarded-host': 'agent.example:443', origin: 'https://agent.example' }))).status).toBe(200);
    expect((await handler(post('/chat', json({ sessionId: 'p2', input: 'hi' }), { ...proxied, forwarded: 'for=10.0.0.1;host="agent.example";proto=https', origin: 'https://agent.example' }))).status).toBe(200);
    expect((await handler(post('/chat', json({ sessionId: 'p3', input: 'hi' }), { ...alice, ...asJson, origin: 'https://app.example' }))).status).toBe(200);
    expect((await handler(post('/chat', json({ sessionId: 'p4', input: 'hi' }), { ...alice, ...asJson, host: 'app.test:80', origin: 'http://app.test' }))).status).toBe(200);
    // A port that is not the scheme's default still has to match.
    expect((await handler(post('/chat', json({ sessionId: 'p5', input: 'hi' }), { ...proxied, 'x-forwarded-host': 'agent.example:8443', origin: 'https://agent.example' }))).status).toBe(403);
    expect((await handler(post('/chat', json({ sessionId: 'p6', input: 'hi' }), { ...proxied, forwarded: 'host=evil.example', origin: 'https://agent.example' }))).status).toBe(403);
  });

  it("allowedOrigins: ['*'] turns the origin check off", async () => {
    const { handler } = routes(['a'], { allowedOrigins: ['*'] });
    expect((await handler(post('/chat', json({ sessionId: 'w1', input: 'hi' }), { ...alice, ...asJson, origin: 'https://other.example' }))).status).toBe(200);
  });

  it('checks the useChat endpoint as well', async () => {
    const { handler } = routes(['a'], { uiMessageStream: true });
    const body = json({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] });
    expect((await handler(post('/ui', body, { ...alice, ...asJson, origin: 'https://evil.example' }))).status).toBe(403);
    expect((await handler(post('/ui', body, { ...alice, 'content-type': 'text/plain' }))).status).toBe(415);
    expect((await handler(post('/ui', body, { ...alice, ...asJson }))).status).toBe(200);
  });
});

describe('JSON bodies', () => {
  it('refuses a form or text/plain body (what another site can send without a preflight) with 415', async () => {
    const { handler, model } = routes(['a']);
    for (const type of ['text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const response = await handler(post('/chat', json({ sessionId: 'j1', input: 'hi' }), { ...alice, 'content-type': type }));
      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({ code: 'LOUSHO_UNSUPPORTED_MEDIA_TYPE' });
    }
    expect((await handler(post('/chat', json({ sessionId: 'j1', input: 'hi' }), alice))).status).toBe(415);
    expect(model.calls).toHaveLength(0);
  });

  it('accepts the JSON type sent twice (a client header next to the default one), but not JSON joined with another type', async () => {
    const { handler, model } = routes(['a']);
    const doubled = await handler(post('/chat', json({ sessionId: 'j4', input: 'hi' }), { ...alice, 'content-type': 'application/json, application/json' }));
    expect(doubled.status).toBe(200);
    await doubled.text();
    expect((await handler(post('/chat', json({ sessionId: 'j5', input: 'hi' }), { ...alice, 'content-type': 'application/json, text/plain' }))).status).toBe(415);
    expect(model.calls).toHaveLength(1);
  });

  it('accepts JSON with parameters, and requireJsonBody: false accepts any type', async () => {
    const { handler } = routes(['a']);
    expect((await handler(post('/chat', json({ sessionId: 'j2', input: 'hi' }), { ...alice, 'content-type': 'application/json; charset=utf-8' }))).status).toBe(200);
    const loose = routes(['a'], { requireJsonBody: false });
    expect((await loose.handler(post('/chat', json({ sessionId: 'j3', input: 'hi' }), { ...alice, 'content-type': 'text/plain' }))).status).toBe(200);
  });
});

describe('allowedHosts', () => {
  it('refuses another Host with 403, but keeps /health open', async () => {
    const { handler } = routes(['a'], { allowedHosts: ['agent.example.com'] });
    const rebound = await handler(post('/chat', json({ sessionId: 'h1', input: 'hi' }), { ...alice, ...asJson, host: 'evil.example' }));
    expect(rebound.status).toBe(403);
    expect(await rebound.json()).toMatchObject({ code: 'LOUSHO_REQUEST_FORBIDDEN' });
    expect((await handler(new Request('http://evil.example/api/agent/health'))).status).toBe(200);
    expect((await handler(post('/chat', json({ sessionId: 'h1', input: 'hi' }), { ...alice, ...asJson, host: 'agent.example.com' }))).status).toBe(200);
  });
});

describe('default session owner', () => {
  it('binds a session to the first principal; another principal cannot read, continue or squat it', async () => {
    const { handler } = routes(['Hi Alice.', 'more', 'x']);
    await (await handler(post('/chat', json({ sessionId: 'alice-chat', input: 'hi' }), { ...alice, ...asJson }))).text();
    const bob = { cookie: 'user=bob' };
    const read = await handler(new Request('http://app.test/api/agent/chat/alice-chat', { headers: bob }));
    expect(read.status).toBe(403);
    expect(await read.json()).toMatchObject({ code: 'LOUSHO_SESSION_FORBIDDEN' });
    expect((await handler(post('/chat', json({ sessionId: 'alice-chat', input: 'hi' }), { ...bob, ...asJson }))).status).toBe(403);
    expect((await handler(new Request('http://app.test/api/agent/chat/alice-chat', { headers: alice }))).status).toBe(200);
  });

  it('a read claims nothing: a GET of an unused id cannot lock its user out', async () => {
    const { handler } = routes(['Hi Alice.']);
    const bob = { cookie: 'user=bob' };
    const early = await handler(new Request('http://app.test/api/agent/chat/alice-2', { headers: bob }));
    expect(early.status).toBe(200);
    expect(await early.json()).toMatchObject({ messages: [] });
    const turn = await handler(post('/chat', json({ sessionId: 'alice-2', input: 'hi' }), { ...alice, ...asJson }));
    expect(turn.status).toBe(200);
    await turn.text();
    expect((await handler(new Request('http://app.test/api/agent/chat/alice-2', { headers: bob }))).status).toBe(403);
    expect((await handler(new Request('http://app.test/api/agent/chat/alice-2', { headers: alice }))).status).toBe(200);
  });

  it(`keeps at most ${MAX_SESSION_OWNERS} owners per agent, forgetting the least recently used`, () => {
    const agent = {};
    const user = (id: string) => ({ id, type: 'user' as const, authenticator: 'custom' });
    expect(sessionOwnership(agent, user('alice'), 'first', true)).toBe('owner');
    expect(sessionOwnership(agent, user('bob'), 'second', true)).toBe('owner');
    for (let i = 0; i < MAX_SESSION_OWNERS - 2; i++) sessionOwnership(agent, user('carol'), `s${i}`, true);
    // A read never claims; using 'first' again makes 'second' the least recently used.
    expect(sessionOwnership(agent, user('bob'), 'unused', false)).toBe('unclaimed');
    expect(sessionOwnership(agent, user('alice'), 'first', false)).toBe('owner');
    sessionOwnership(agent, user('carol'), 'one-more', true);
    expect(sessionOwnership(agent, user('bob'), 'first', false)).toBe('other');
    expect(sessionOwnership(agent, user('alice'), 'second', false)).toBe('unclaimed');
  });

  it('a route without auth checks no owner', async () => {
    const agent = createAgent({ provider: mockModel(['a']), store: memoryStore() });
    const { handler } = createRouteHandler(agent);
    await (await handler(post('/chat', json({ sessionId: 'open-1', input: 'hi' }), asJson))).text();
    expect((await handler(new Request('http://app.test/api/agent/chat/open-1'))).status).toBe(200);
  });

  it('applies on serveFetch (the deployed server and Worker) too', async () => {
    const agent = createAgent({ provider: mockModel(['a']), store: memoryStore() });
    const ctx = { name: 'test', agent: () => agent };
    await (await serveFetch(new Request('http://srv/chat', { method: 'POST', headers: { ...alice, ...asJson }, body: json({ sessionId: 'sf1', input: 'hi' }) }), ctx, cookieAuth)).text();
    expect((await serveFetch(new Request('http://srv/chat/sf1', { headers: { cookie: 'user=bob' } }), ctx, cookieAuth)).status).toBe(403);
    expect((await serveFetch(new Request('http://srv/chat/sf1', { headers: alice }), ctx, cookieAuth)).status).toBe(200);
  });
});
