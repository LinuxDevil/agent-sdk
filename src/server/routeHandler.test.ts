import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai-v7';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { memoryStore } from '../storage/agentStore';
import { createAgentRunner } from '../ui/agentRunner';
import { initialAgentUIState, reduceAgentEvents, type AgentUIState } from '../ui/reducer';
import { createRouteHandler, type RouteHandlerOptions } from './routeHandler';

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

  it('strips the base path, accepts a trailing slash, and 404s outside it', async () => {
    const { handler } = routes(['a', 'b'], { basePath: '/v1/bot/' });
    expect((await handler(post('/v1/bot/chat/', { sessionId: 's5', input: 'hi' }))).status).toBe(200);
    expect((await handler(get('/v1/bot/chat/s5'))).status).toBe(200);
    expect((await handler(post('/api/agent/chat', { sessionId: 's5', input: 'hi' }))).status).toBe(404);
    expect((await handler(post('/v1/botany/chat', { sessionId: 's5', input: 'hi' }))).status).toBe(404);
    expect((await handler(get('/v1/bot/nope'))).status).toBe(404);
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
