/**
 * LOU-D14: the deployed node server's /chat API, in process with a scripted
 * model - sessions, SSE, approvals, the legacy body, bearer auth and the store env.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type * as http from 'node:http';
import { z } from 'zod';
import { createAgent, type SimpleAgent } from '../createAgent';
import { mockModel } from '../testing';
import { defineTool } from '../tools/defineTool';
import { memoryStore } from '../storage/agentStore';
import { SqliteStore } from '../storage/sqlite';
import { parseEventStream } from '../ui/parseEventStream';
import type { AgentEvent } from '../execution/agentEvents';
import { createDeployedServer, storeFromEnv, type DeployedServerOptions } from './nodeServer';
import { apiToken, basic, type Principal } from '../auth';
import { defineChannel } from '../channels/defineChannel';
import type { RunConfigContext } from '../createAgent';

const ping = defineTool({ name: 'ping', description: 'Reply with pong', input: z.object({}), execute: () => 'pong', needsApproval: true });
const pinged = { toolCalls: [{ name: 'ping' }] };

let server: http.Server | undefined;
let agent: SimpleAgent | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  await agent?.close();
  server = agent = undefined;
});

async function serve(provider: ReturnType<typeof mockModel>, options: DeployedServerOptions = { env: {} }, store = memoryStore()) {
  agent = createAgent({ provider, tools: [ping], store });
  const created = createDeployedServer(agent, options);
  server = created.server;
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (route: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + route, body === undefined ? { headers } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const events = async (res: Response) => {
    const out: AgentEvent[] = [];
    for await (const event of parseEventStream(res)) out.push(event);
    return out;
  };
  return { call, events, authenticated: created.authenticated };
}

describe('deployed node server /chat API', () => {
  it('streams a turn as SSE and ends with event: done', async () => {
    const { call, events } = await serve(mockModel(['Hello there.']));
    const res = await call('/chat', { sessionId: 's1', input: 'hi' });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const raw = await res.text();
    expect(raw.endsWith('event: done\ndata: {}\n\n')).toBe(true);
    const turn = await events(new Response(raw));
    expect(turn[0].type).toBe('run.start');
    expect(turn.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'stop', text: 'Hello there.' });
  });

  it('keeps history per session: the second turn sees the first, GET /chat/:id returns the transcript', async () => {
    const provider = mockModel(['Nice to meet you, Ali.', 'You are Ali.']);
    const { call, events } = await serve(provider);
    await events(await call('/chat', { sessionId: 'tab-a', input: 'My name is Ali.' }));
    await events(await call('/chat', { sessionId: 'tab-a', input: 'Who am I?' }));
    const history = provider.calls[1].messages.map((m) => `${m.role}:${String(m.content)}`);
    expect(history).toContain('user:My name is Ali.');
    expect(history).toContain('assistant:Nice to meet you, Ali.');

    const saved = await (await call('/chat/tab-a')).json();
    expect(saved.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect((await call('/chat/not%20valid!')).status).toBe(400);
  });

  it('pauses a tool call for approval and streams the continuation from the approvals endpoint', async () => {
    const { call, events } = await serve(mockModel([pinged, 'The tool said pong.']));
    const paused = await events(await call('/chat', { sessionId: 's2', input: 'ping it' }));
    const requested = paused.find((e) => e.type === 'approval.requested') as { approvalId: string } | undefined;
    expect(requested).toMatchObject({ toolName: 'ping' });
    expect(paused.at(-1)).toMatchObject({ finishReason: 'awaiting-approval' });

    const continued = await events(await call(`/chat/s2/approvals/${requested!.approvalId}`, { approved: true }));
    expect(continued.find((e) => e.type === 'tool.done')).toMatchObject({ toolName: 'ping', result: 'pong' });
    expect(continued.at(-1)).toMatchObject({ finishReason: 'stop', text: 'The tool said pong.' });
    expect((await call(`/chat/s2/approvals/${requested!.approvalId}`, { approved: true })).status).toBe(404);
    expect((await call('/chat/s2/approvals/x', {})).status).toBe(400);
  });

  it('still answers the legacy { message } body with the non-streamed result, and rejects bad bodies', async () => {
    const { call } = await serve(mockModel(['legacy reply']));
    const res = await call('/chat', { message: 'hi' });
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()).text).toBe('legacy reply');
    expect((await call('/chat', {})).status).toBe(400);
    expect((await call('/chat', { message: 'x'.repeat(2 * 1024 * 1024) })).status).toBe(413);
    expect((await call('/nope')).status).toBe(404);
  });

  describe('bearer auth', () => {
    it('is off without a token: every route is open', async () => {
      const { call, authenticated } = await serve(mockModel(['ok']));
      expect(authenticated).toBe(false);
      expect((await call('/chat/open')).status).toBe(200);
    });

    it('requires the token on every route but /health: 401 JSON without or with a wrong one, 200 with it', async () => {
      const { call, events, authenticated } = await serve(mockModel(['secret answer']), { env: { LOUSHO_API_TOKEN: 's3cret' } });
      expect(authenticated).toBe(true);
      expect((await call('/health')).status).toBe(200);

      for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: 'Bearer s3cret-and-more' }, { Authorization: 's3cret' }, { Authorization: 'Basic s3cret' }]) {
        const denied = await call('/chat', { sessionId: 'a', input: 'hi' }, headers);
        expect(denied.status).toBe(401);
        expect(denied.headers.get('content-type')).toContain('application/json');
        expect(denied.headers.get('www-authenticate')).toBe('Bearer');
        expect(await denied.json()).toMatchObject({ error: expect.stringContaining('Unauthorized') });
      }
      expect((await call('/chat/a')).status).toBe(401);
      expect((await call('/nope')).status).toBe(401);

      const bearer = { Authorization: 'Bearer s3cret' };
      expect((await events(await call('/chat', { sessionId: 'a', input: 'hi' }, bearer))).at(-1)).toMatchObject({ text: 'secret answer' });
      expect((await call('/chat/a', undefined, bearer)).status).toBe(200);
    });

    it('takes the build option token, which LOUSHO_API_TOKEN overrides', async () => {
      const built = await serve(mockModel(['ok']), { auth: { token: 'baked' }, env: {} });
      expect((await built.call('/chat/a')).status).toBe(401);
      expect((await built.call('/chat/a', undefined, { Authorization: 'Bearer baked' })).status).toBe(200);
      await agent?.close();
      server?.closeAllConnections();
      server?.close();

      const env = await serve(mockModel(['ok']), { auth: { token: 'baked' }, env: { LOUSHO_API_TOKEN: 'from-env' } });
      expect((await env.call('/chat/a', undefined, { Authorization: 'Bearer baked' })).status).toBe(401);
      expect((await env.call('/chat/a', undefined, { Authorization: 'Bearer from-env' })).status).toBe(200);
    });
  });
});

describe('deployed node server auth list (N10a)', () => {
  const basicHeader = (user: string, password: string) => ({ Authorization: `Basic ${btoa(`${user}:${password}`)}` });

  async function serveWithPrincipal(options: DeployedServerOptions) {
    const seen: Array<Principal | undefined> = [];
    const replies: string[] = [];
    agent = createAgent({
      provider: mockModel(Array.from({ length: 5 }, () => 'ok')),
      instructions: ({ principal }: RunConfigContext) => (seen.push(principal), 'x'),
    });
    const sms = defineChannel({
      name: 'sms',
      parse: async (req) => ({ sessionKey: 'c1', input: req.text, replyTo: 'c1' }),
      reply: async ({ text }) => void replies.push(text),
    });
    const created = createDeployedServer(agent, { ...options, channels: [sms] });
    server = created.server;
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const chat = async (headers: Record<string, string>) => {
      const res = await fetch(`${base}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ sessionId: 's', input: 'hi' }) });
      await res.text();
      return res;
    };
    return { base, chat, seen, replies, authenticated: created.authenticated };
  }

  it('checks the list, then LOUSHO_API_TOKEN appended after it, and the run sees who called', async () => {
    const { chat, seen, authenticated } = await serveWithPrincipal({ auth: [basic({ users: { ops: 'pw' } })], env: { LOUSHO_API_TOKEN: 'env-token' } });
    expect(authenticated).toBe(true);
    expect((await chat(basicHeader('ops', 'pw'))).status).toBe(200);
    expect((await chat({ Authorization: 'Bearer env-token' })).status).toBe(200);
    const denied = await chat(basicHeader('ops', 'wrong'));
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toBe('Basic realm="lousho", charset="UTF-8", Bearer');
    expect(seen.map((p) => `${p?.authenticator}:${p?.id}`)).toEqual(['basic:ops', 'api-token:api-token']);
  });

  it('a single entry works without the env token, and an empty list closes the chat routes', async () => {
    const one = await serveWithPrincipal({ auth: apiToken('t', { id: 'svc' }), env: {} });
    expect((await one.chat({ Authorization: 'Bearer t' })).status).toBe(200);
    expect((await one.chat({})).status).toBe(401);
    expect(one.seen[0]).toEqual({ id: 'svc', type: 'service', authenticator: 'api-token' });
    server?.closeAllConnections();
    await new Promise((resolve) => server!.close(resolve));

    const closed = await serveWithPrincipal({ auth: [], env: {} });
    expect(closed.authenticated).toBe(true);
    expect((await closed.chat({ Authorization: 'Bearer t' })).status).toBe(401);
  });

  it('channels are answered without the route auth (they verify themselves)', async () => {
    const { base, replies } = await serveWithPrincipal({ auth: [basic({ users: { ops: 'pw' } })], env: {} });
    const hook = await fetch(`${base}/channels/sms`, { method: 'POST', body: 'ping' });
    expect(hook.status).toBe(200);
    expect(replies).toEqual(['ok']);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/chat/s`)).status).toBe(401);
  });
});

describe('storeFromEnv', () => {
  it("defaults to memory, accepts 'memory' and 'sqlite:<path>', and rejects anything else", () => {
    expect(storeFromEnv({}).sessions).toBeDefined();
    expect(storeFromEnv({ LOUSHO_STORE: 'memory' }).sessions).toBeDefined();
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-store-')), 'agent.db');
    const store = storeFromEnv({ LOUSHO_STORE: `sqlite:${file}` });
    expect(store).toBeInstanceOf(SqliteStore);
    (store as SqliteStore).close();
    expect(fs.existsSync(file)).toBe(true);
    expect(() => storeFromEnv({ LOUSHO_STORE: 'redis://x' })).toThrow(/LOUSHO_STORE must be 'memory' or 'sqlite:<path>'/);
    expect(() => storeFromEnv({ LOUSHO_STORE: 'sqlite:' })).toThrow(/LOUSHO_STORE/);
  });
});
