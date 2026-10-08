import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai-v7';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { memoryStore } from '../storage/agentStore';
import { createAgentRunner } from '../ui/agentRunner';
import { initialAgentUIState, reduceAgentEvents, type AgentUIState } from '../ui/reducer';
import { createRouteHandler, type RouteHandlerOptions } from './routeHandler';
import { defineMemory, inMemoryMemory, type MemoryScopeContext } from '../memory';
import type { RunConfigContext } from '../createAgent';
import { AuthError, apiToken, basic, jwt, type AuthFn, type Principal } from '../auth';
import { SECRET, hmacKey, signToken } from '../auth/__fixtures__/tokens';

const deploy = defineTool({ name: 'deploy', description: 'Deploys', input: z.object({}), needsApproval: true, execute: () => 'shipped' });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://app.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const get = (path: string, headers: Record<string, string> = {}) => new Request(`http://app.test${path}`, { headers });

async function frames(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: ') && frame !== 'data: [DONE]')
    .map((frame) => JSON.parse(frame.slice(6)));
}

const routes = (replies: Parameters<typeof mockModel>[0], options?: RouteHandlerOptions) =>
  createRouteHandler(createAgent({ provider: mockModel(replies), tools: [deploy], store: memoryStore() }), options);

describe('createRouteHandler (LOU-P4)', () => {
  it('streams a chat turn through POST and serves the transcript through GET', async () => {
    const { POST, GET } = routes(['Hello there.']);
    const response = await POST(post('/api/agent/chat', { sessionId: 's1', input: 'hi' }));
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const events = await frames(response);
    expect(events.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'stop', text: 'Hello there.' });
    const saved = await (await GET(get('/api/agent/chat/s1'))).json();
    expect(saved.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
  });

  it('round-trips an approval and streams the continuation', async () => {
    const { handler } = routes([{ toolCalls: [{ name: 'deploy', id: 'c1' }] }, 'Deployed.']);
    const paused = await frames(await handler(post('/api/agent/chat', { sessionId: 's2', input: 'ship it' })));
    const requested = paused.find((e) => e.type === 'approval.requested') as { approvalId: string };
    expect(paused.at(-1)).toMatchObject({ finishReason: 'awaiting-approval' });
    const continued = await frames(await handler(post(`/api/agent/chat/s2/approvals/${requested.approvalId}`, { approved: true })));
    expect(continued.find((e) => e.type === 'tool.done')).toMatchObject({ result: 'shipped' });
    expect(continued.at(-1)).toMatchObject({ finishReason: 'stop', text: 'Deployed.' });
  });

  it('checks a bearer token, but leaves /health open', async () => {
    const { handler } = routes(['ok'], { auth: 'sekret' });
    const body = { sessionId: 's3', input: 'hi' };
    const denied = await handler(post('/api/agent/chat', body));
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toBe('Bearer');
    expect((await handler(post('/api/agent/chat', body, { authorization: 'Bearer wrong' }))).status).toBe(401);
    expect((await handler(post('/api/agent/chat', body, { authorization: 'Bearer sekret' }))).status).toBe(200);
    expect(await (await handler(get('/api/agent/health'))).text()).toBe('ok');
  });

  it('asks an authorizer function, sync or async', async () => {
    const seen: string[] = [];
    const { handler } = routes(['ok', 'ok'], {
      auth: async (request) => {
        seen.push(request.method);
        return request.headers.get('x-user') === 'ada';
      },
    });
    const body = { sessionId: 's4', input: 'hi' };
    expect((await handler(post('/api/agent/chat', body))).status).toBe(401);
    expect((await handler(post('/api/agent/chat', body, { 'x-user': 'ada' }))).status).toBe(200);
    expect(seen).toEqual(['POST', 'POST']);
  });

  it('keeps a boolean authorizer meaning what it did: true runs with the custom anonymous principal', async () => {
    const seen: Array<Principal | undefined> = [];
    const agent = createAgent({
      provider: mockModel(['ok']),
      instructions: ({ principal }: RunConfigContext) => (seen.push(principal), 'be brief'),
    });
    const { handler } = createRouteHandler(agent, { auth: () => true });
    const response = await handler(post('/api/agent/chat', { sessionId: 'b1', input: 'hi' }));
    expect(response.status).toBe(200);
    await response.text();
    expect(seen).toEqual([{ id: 'anonymous', type: 'user', authenticator: 'custom' }]);
  });

  describe('auth lists (N10a)', () => {
    const scopes: MemoryScopeContext[] = [];
    const seen: Array<Principal | undefined> = [];
    const agentWithPrincipal = (replies: string[]) =>
      createAgent({
        provider: mockModel(replies),
        store: memoryStore(),
        instructions: ({ principal }: RunConfigContext) => (seen.push(principal), `You serve ${principal?.id ?? 'nobody'}.`),
        memory: [defineMemory({ name: 'notes', scope: (ctx) => (scopes.push(ctx), ctx.principal && `user:${ctx.principal.issuer ?? ''}:${ctx.principal.id}`), provider: inMemoryMemory() })],
      });

    it('runs the list in order and hands the accepted principal to instructions and memory scopes', async () => {
      seen.length = 0;
      scopes.length = 0;
      const hs = await hmacKey();
      const { handler } = createRouteHandler(agentWithPrincipal(['one', 'two']), {
        auth: [jwt({ secret: SECRET, issuer: 'https://iss.test', audience: 'agent' }), apiToken('ci-token', { id: 'ci' })],
      });
      const token = await signToken(hs, { sub: 'ada', iss: 'https://iss.test', aud: 'agent' });
      for (const [sessionId, authorization] of [['p1', `Bearer ${token}`], ['p2', 'Bearer ci-token']]) {
        const response = await handler(post('/api/agent/chat', { sessionId, input: 'hi' }, { authorization }));
        expect(response.status).toBe(200);
        await response.text();
      }
      expect(seen.map((p) => [p?.authenticator, p?.id, p?.issuer])).toEqual([
        ['jwt', 'ada', 'https://iss.test'],
        ['api-token', 'ci', undefined],
      ]);
      expect(scopes.map((ctx) => ctx.principal?.id)).toEqual(['ada', 'ci']);
      expect(scopes[0]).toMatchObject({ sessionId: 'p1', principal: { claims: expect.objectContaining({ aud: 'agent' }) } });
    });

    it('answers 401 with every challenge when nothing matches, 403 for AuthError(403), and leaves /health open', async () => {
      const forbidden = () => {
        throw new AuthError(403);
      };
      const { handler } = createRouteHandler(agentWithPrincipal(['x']), { auth: [apiToken('t'), basic({ users: { a: 'b' } })] });
      const denied = await handler(post('/api/agent/chat', { sessionId: 'p3', input: 'hi' }));
      expect(denied.status).toBe(401);
      expect(denied.headers.get('www-authenticate')).toBe('Bearer, Basic realm="lousho", charset="UTF-8"');
      expect(await denied.json()).toEqual({ error: 'Unauthorized' });
      expect(await (await handler(get('/api/agent/health'))).text()).toBe('ok');
      const { handler: closed } = createRouteHandler(agentWithPrincipal(['x']), { auth: [forbidden] });
      expect((await closed(get('/api/agent/chat/p3'))).status).toBe(403);
      expect(await (await closed(get('/api/agent/health'))).text()).toBe('ok');
    });

    it('the useChat endpoint and the useLoushoAgent route run with the principal too', async () => {
      seen.length = 0;
      const { handler } = createRouteHandler(agentWithPrincipal(['a', 'b']), { auth: apiToken('t', { id: 'web' }), uiMessageStream: true });
      const headers = { authorization: 'Bearer t' };
      await (await handler(post('/api/agent/ui', { id: 'u1', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }, headers))).text();
      await (await handler(post('/api/agent', { input: 'hi' }, headers))).text();
      expect(seen.map((p) => p?.id)).toEqual(['web', 'web']);
    });

    it('warns once in production when a route has no auth', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        routes(['x']);
        routes(['x']);
        routes(['x'], { auth: 't' });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('no `auth`');
      } finally {
        process.env.NODE_ENV = previous;
        warn.mockRestore();
      }
    });
  });

  it('strips the base path, accepts a trailing slash, and 404s outside it', async () => {
    const { handler } = routes(['a', 'b'], { basePath: '/v1/bot/' });
    expect((await handler(post('/v1/bot/chat/', { sessionId: 's5', input: 'hi' }))).status).toBe(200);
    expect((await handler(get('/v1/bot/chat/s5'))).status).toBe(200);
    expect((await handler(post('/api/agent/chat', { sessionId: 's5', input: 'hi' }))).status).toBe(404);
    expect((await handler(post('/v1/botany/chat', { sessionId: 's5', input: 'hi' }))).status).toBe(404);
    expect((await handler(get('/v1/bot/nope'))).status).toBe(404);
  });

  describe('session ownership and approval decisions (N10b)', () => {
    /** `Bearer u-<id>` authenticates the user principal `{ id, type: 'user', authenticator: 'test' }`. */
    const userAuth: AuthFn = async (request) => {
      const id = /^Bearer u-(.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
      return id === undefined ? null : { id, type: 'user', authenticator: 'test' };
    };
    const as = (user: string) => ({ authorization: `Bearer u-${user}` });
    const authed = (replies: Parameters<typeof mockModel>[0], options?: RouteHandlerOptions) =>
      createRouteHandler(createAgent({ provider: mockModel(replies), tools: [deploy], store: memoryStore() }), { auth: [userAuth], ...options });

    it('a gated pause cannot be approved by the user it runs for; another caller can', async () => {
      const { handler } = authed([{ toolCalls: [{ name: 'deploy', id: 'c1' }] }, 'Deployed.']);
      const paused = await frames(await handler(post('/api/agent/chat', { sessionId: 'g1', input: 'ship it' }, as('alice'))));
      const { approvalId } = paused.find((e) => e.type === 'approval.requested') as { approvalId: string };
      const self = await handler(post(`/api/agent/chat/g1/approvals/${approvalId}`, { approved: true }, as('alice')));
      expect(self.status).toBe(403);
      expect(await self.json()).toEqual({ error: 'This caller may not decide this approval' });
      const other = await frames(await handler(post(`/api/agent/chat/g1/approvals/${approvalId}`, { approved: true }, as('staff'))));
      expect(other.find((e) => e.type === 'tool.done')).toMatchObject({ result: 'shipped' });
    });

    it('approvers as a list or a function names who may decide, self included', async () => {
      const listed = authed([{ toolCalls: [{ name: 'deploy', id: 'c1' }] }, 'x', { toolCalls: [{ name: 'deploy', id: 'c2' }] }, 'y'], { approvers: ['staff'] });
      const first = await frames(await listed.handler(post('/api/agent/chat', { sessionId: 'l1', input: 'a' }, as('alice'))));
      const a1 = (first.find((e) => e.type === 'approval.requested') as { approvalId: string }).approvalId;
      expect((await listed.handler(post(`/api/agent/chat/l1/approvals/${a1}`, { approved: true }, as('staff')))).status).toBe(200);
      const second = await frames(await listed.handler(post('/api/agent/chat', { sessionId: 'l2', input: 'b' }, as('bob'))));
      const a2 = (second.find((e) => e.type === 'approval.requested') as { approvalId: string }).approvalId;
      expect((await listed.handler(post(`/api/agent/chat/l2/approvals/${a2}`, { approved: true }, as('bob')))).status).toBe(403);

      const byFunction = authed([{ toolCalls: [{ name: 'deploy', id: 'c3' }] }, 'z'], {
        approvers: (caller, pending) => caller?.id === 'alice' && pending.toolName === 'deploy',
      });
      const paused = await frames(await byFunction.handler(post('/api/agent/chat', { sessionId: 'f1', input: 'c' }, as('alice'))));
      const a3 = (paused.find((e) => e.type === 'approval.requested') as { approvalId: string }).approvalId;
      // an explicit policy can re-allow self-approval (e.g. a single-user app)
      expect((await byFunction.handler(post(`/api/agent/chat/f1/approvals/${a3}`, { approved: true }, as('alice')))).status).toBe(200);
    });

    it('a service principal (a shared token, a remote agent) may decide its own pause', async () => {
      const { handler } = routes([{ toolCalls: [{ name: 'deploy', id: 'c1' }] }, 'Deployed.'], { auth: 't' });
      const headers = { authorization: 'Bearer t' };
      const paused = await frames(await handler(post('/api/agent/chat', { sessionId: 'sv1', input: 'ship it' }, headers)));
      const { approvalId } = paused.find((e) => e.type === 'approval.requested') as { approvalId: string };
      const continued = await frames(await handler(post(`/api/agent/chat/sv1/approvals/${approvalId}`, { approved: true }, headers)));
      expect(continued.find((e) => e.type === 'tool.done')).toMatchObject({ result: 'shipped' });
    });

    it('a session is bound to the first authenticated caller; others get 403 on read and write', async () => {
      const { handler } = authed(['Hi Alice.', 'follow-up']);
      await (await handler(post('/api/agent/chat', { sessionId: 'mine', input: 'hi' }, as('alice')))).text();
      expect((await handler(get('/api/agent/chat/mine', as('bob')))).status).toBe(403);
      expect((await handler(post('/api/agent/chat', { sessionId: 'mine', input: 'what did we discuss?' }, as('bob')))).status).toBe(403);
      expect((await handler(get('/api/agent/chat/mine', as('alice')))).status).toBe(200);
      expect((await handler(post('/api/agent/chat', { sessionId: 'mine', input: 'again' }, as('alice')))).status).toBe(200);
    });

    it('ownsSession replaces the default binding (e.g. shared or derived ids)', async () => {
      const { handler } = authed(['a', 'b'], { ownsSession: (principal, sessionId) => sessionId === `u-${principal?.id}` });
      expect((await handler(post('/api/agent/chat', { sessionId: 'u-alice', input: 'hi' }, as('alice')))).status).toBe(200);
      expect((await handler(post('/api/agent/chat', { sessionId: 'u-alice', input: 'hi' }, as('bob')))).status).toBe(403);
    });

    it('the approvals route 404s when the named session waits on a different pause', async () => {
      const { handler } = authed([
        { toolCalls: [{ name: 'deploy', id: 'c1' }] },
        { toolCalls: [{ name: 'deploy', id: 'c2' }] },
        'x',
      ]);
      const first = await frames(await handler(post('/api/agent/chat', { sessionId: 'w1', input: 'a' }, as('alice'))));
      const a1 = (first.find((e) => e.type === 'approval.requested') as { approvalId: string }).approvalId;
      const second = await frames(await handler(post('/api/agent/chat', { sessionId: 'w2', input: 'b' }, as('staff'))));
      expect(second.find((e) => e.type === 'approval.requested')).toBeDefined();
      // w2 waits on its own pause, not a1: naming a1 under w2 is a mismatch
      expect((await handler(post(`/api/agent/chat/w2/approvals/${a1}`, { approved: true }, as('staff')))).status).toBe(404);
      // and a1 itself is still decidable by another caller under any session path not bound to a pause
      expect((await handler(post(`/api/agent/chat/fresh/approvals/${a1}`, { approved: true }, as('staff')))).status).toBe(200);
    });

    it('a question pause is answered by the user it was asked of (self-resolution allowed)', async () => {
      const agent = createAgent({
        provider: mockModel([{ toolCalls: [{ name: 'ask_question', args: { question: 'Where?', options: ['Porto', 'Lisbon'] }, id: 'q1' }] }, 'Lisbon.']),
        store: memoryStore(),
        askQuestion: true,
      });
      const { handler } = createRouteHandler(agent, { auth: [userAuth] });
      const paused = await frames(await handler(post('/api/agent/chat', { sessionId: 'q', input: 'plan' }, as('alice'))));
      const question = paused.find((e) => e.type === 'approval.requested') as { approvalId: string };
      expect(question).toMatchObject({ kind: 'question' });
      const answered = await frames(await handler(post(`/api/agent/chat/q/approvals/${question.approvalId}`, { answer: 'Lisbon' }, as('alice'))));
      expect(answered.find((e) => e.type === 'tool.done')).toBeDefined();
    });
  });

  it('serves the remote createAgentRunner behind useLoushoAgent({ url, approvalsUrl }) unchanged, approvals included', async () => {
    const { handler } = routes([{ toolCalls: [{ name: 'deploy', id: 'c1' }] }, 'Deployed.']);
    let state: AgentUIState = initialAgentUIState;
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(`http://app.test${String(input)}`, init))) as typeof fetch;
    const runner = createAgentRunner({
      source: () => ({ url: '/api/agent', fetch: fetchImpl }),
      options: () => ({ approvalsUrl: '/api/agent/approvals' }),
      state: () => state,
      dispatch: (action) => {
        state = reduceAgentEvents(state, action);
      },
    });
    await runner.send('ship it');
    expect(state.pendingApproval).toMatchObject({ toolName: 'deploy' });
    await runner.approve();
    expect(state.pendingApproval).toBeNull();
    expect(JSON.stringify(state.messages.at(-1))).toContain('Deployed.');
  });

  describe('uiMessageStream', () => {
    const userMessage = (text: string) => ({ id: 'm', role: 'user', parts: [{ type: 'text', text }] });

    it('answers useChat with a UI message stream that the ai reader understands, in the session named by id', async () => {
      const { handler, GET } = routes(['Hi Ada.'], { uiMessageStream: true });
      const response = await handler(post('/api/agent/ui', { id: 'chat-1', messages: [userMessage('hi')] }));
      expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
      const lines = (await response.text()).split('\n\n').filter((frame) => frame.startsWith('data: ') && frame !== 'data: [DONE]');
      const stream = new ReadableStream<UIMessageChunk>({
        start(controller) {
          for (const line of lines) controller.enqueue(JSON.parse(line.slice(6)));
          controller.close();
        },
      });
      let last: UIMessage | undefined;
      for await (const message of readUIMessageStream({ stream })) last = message;
      expect(last?.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'Hi Ada.' });
      const saved = await (await GET(get('/api/agent/chat/chat-1'))).json();
      expect(saved.messages).toHaveLength(2);
    });

    it('runs without a session when no id is posted, rejects a bad body, and is off by default', async () => {
      const on = routes(['ok'], { uiMessageStream: true });
      expect((await on.handler(post('/api/agent/ui', { messages: [userMessage('hi')] }))).status).toBe(200);
      expect((await on.handler(post('/api/agent/ui', { nope: true }))).status).toBe(400);
      expect((await routes(['ok']).handler(post('/api/agent/ui', { messages: [userMessage('hi')] }))).status).toBe(404);
    });
  });
});
