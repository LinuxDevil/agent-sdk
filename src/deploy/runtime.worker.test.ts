/**
 * LOU-D51: the Worker's `/chat` API (sessions over KV, SSE, approvals, bearer
 * auth) in process: the shared Fetch routes over `createAgent({ store: KVStore })`
 * with a scripted model, and `handleWorkerRequest` over a fake KV binding.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { defineTool } from '../tools/defineTool';
import { parseEventStream } from '../react/parseEventStream';
import type { AgentEvent } from '../execution/agentEvents';
import { serveFetch } from '../server/fetchRoutes';
import type { KVBinding } from './kvCheckpointStore';
import { KVStore } from './kvStore';
import { handleWorkerRequest, workerStore } from './runtime.worker';

function fakeKV(): KVBinding & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (key) => data.get(key) ?? null, put: async (key, value) => void data.set(key, value), delete: async (key) => void data.delete(key) };
}

const ping = defineTool({ name: 'ping', description: 'Reply with pong', input: z.object({}), execute: () => 'pong', needsApproval: true });
const pinged = { toolCalls: [{ name: 'ping' }] };

/** One Worker request: a fresh agent (as a fresh isolate has) over the namespace, behind the routes. */
function worker(kv: KVBinding, provider: ReturnType<typeof mockModel>, token?: string) {
  const handle = (route: string, body?: unknown, headers: Record<string, string> = {}) => {
    const agent = createAgent({ provider, tools: [ping], store: new KVStore(kv) });
    const request = new Request(`http://worker${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return serveFetch(request, { name: 'test worker', agent: () => agent }, token);
  };
  const events = async (response: Response) => {
    const out: AgentEvent[] = [];
    for await (const event of parseEventStream(response)) out.push(event);
    return out;
  };
  return { handle, events };
}

describe('Worker /chat API over KVStore', () => {
  it('streams a turn as SSE and ends with event: done', async () => {
    const { handle } = worker(fakeKV(), mockModel(['Hello there.']));
    const response = await handle('/chat', { sessionId: 's1', input: 'hi' });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const raw = await response.text();
    expect(raw.endsWith('event: done\ndata: {}\n\n')).toBe(true);
    const frames = raw.split('\n\n').filter((frame) => frame.startsWith('data: ') && frame !== 'data: {}');
    expect(JSON.parse(frames[0].slice(6))).toMatchObject({ type: 'run.start' });
    expect(JSON.parse(frames.at(-1)!.slice(6))).toMatchObject({ type: 'run.done', finishReason: 'stop', text: 'Hello there.' });
  });

  it('keeps history in KV: a later request (a new agent) sees the first turn, GET /chat/:id returns the transcript', async () => {
    const kv = fakeKV();
    const provider = mockModel(['Nice to meet you, Ali.', 'You are Ali.']);
    const { handle, events } = worker(kv, provider);
    await events(await handle('/chat', { sessionId: 'tab-a', input: 'My name is Ali.' }));
    await events(await handle('/chat', { sessionId: 'tab-a', input: 'Who am I?' }));
    const history = provider.calls[1].messages.map((m) => `${m.role}:${String(m.content)}`);
    expect(history).toContain('user:My name is Ali.');
    expect(history).toContain('assistant:Nice to meet you, Ali.');
    expect(kv.data.has('sessions/tab-a')).toBe(true);

    const saved = await (await handle('/chat/tab-a')).json();
    expect(saved.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect((await handle('/chat/not%20valid!')).status).toBe(400);
  });

  it('pauses a tool call for approval; the approvals endpoint, on a new agent, streams the continuation', async () => {
    const kv = fakeKV();
    const provider = mockModel([pinged, 'The tool said pong.']);
    const { handle, events } = worker(kv, provider);
    const paused = await events(await handle('/chat', { sessionId: 's2', input: 'ping it' }));
    const requested = paused.find((event) => event.type === 'approval.requested') as { approvalId: string } | undefined;
    expect(requested).toMatchObject({ toolName: 'ping' });
    expect(paused.at(-1)).toMatchObject({ finishReason: 'awaiting-approval' });
    expect(kv.data.has(`approvals/${requested!.approvalId}`)).toBe(true);
    expect(await (await handle('/chat/s2')).json()).toMatchObject({ pending: { status: 'awaiting-approval', approvalId: requested!.approvalId } });

    const continued = await events(await handle(`/chat/s2/approvals/${requested!.approvalId}`, { approved: true }));
    expect(continued.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'stop', text: 'The tool said pong.' });
    expect(kv.data.has(`approvals/${requested!.approvalId}`)).toBe(false);
    expect((await (await handle('/chat/s2')).json()).messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect((await handle(`/chat/s2/approvals/${requested!.approvalId}`, { approved: true })).status).toBe(404);
    expect((await handle('/chat/s2/approvals/x', {})).status).toBe(400);
  });

  it('answers the legacy { message } body with the non-streamed result and rejects bad bodies', async () => {
    const { handle } = worker(fakeKV(), mockModel(['legacy reply']));
    const response = await handle('/chat', { message: 'hi' });
    expect(response.headers.get('content-type')).toContain('application/json');
    expect((await response.json()).text).toBe('legacy reply');
    expect((await handle('/chat', {})).status).toBe(400);
    expect((await handle('/chat', { message: 'hi', sessionId: 5 })).status).toBe(400);
    expect((await handle('/chat', { message: 'x'.repeat(2 * 1024 * 1024) })).status).toBe(413);
    expect((await handle('/nope')).status).toBe(404);
  });

  describe('bearer auth', () => {
    it('is off without a token', async () => {
      const { handle } = worker(fakeKV(), mockModel(['ok']));
      expect((await handle('/chat/open')).status).toBe(200);
    });

    it('requires the token on every route but /health: 401 JSON without or with a wrong one, 200 with it', async () => {
      const { handle, events } = worker(fakeKV(), mockModel(['secret answer']), 's3cret');
      expect((await handle('/health')).status).toBe(200);
      for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: 'Bearer s3cret-and-more' }, { Authorization: 's3cret' }, { Authorization: 'Basic s3cret' }]) {
        const denied = await handle('/chat', { sessionId: 'a', input: 'hi' }, headers);
        expect(denied.status).toBe(401);
        expect(denied.headers.get('www-authenticate')).toBe('Bearer');
        expect(await denied.json()).toMatchObject({ error: expect.stringContaining('Unauthorized') });
      }
      expect((await handle('/chat/a')).status).toBe(401);
      expect((await handle('/nope')).status).toBe(401);

      const bearer = { Authorization: 'Bearer s3cret' };
      expect((await events(await handle('/chat', { sessionId: 'a', input: 'hi' }, bearer))).at(-1)).toMatchObject({ text: 'secret answer' });
      expect((await handle('/chat/a', undefined, bearer)).status).toBe(200);
    });
  });
});

describe('handleWorkerRequest', () => {
  const spec = { name: 'Edge Agent', prompt: 'You are an edge agent.', provider: { type: 'mock', model: 'mock-1' }, tools: ['current-date'] };
  const call = (env: Record<string, unknown>, route: string, body?: unknown, headers: Record<string, string> = {}) =>
    handleWorkerRequest(
      new Request(`http://worker${route}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      env,
      spec
    );

  it('serves a session over the AGENT_CHECKPOINTS namespace, with LOUSHY_API_TOKEN from env', async () => {
    const kv = fakeKV();
    const env = { AGENT_CHECKPOINTS: kv, LOUSHY_API_TOKEN: 'tok' };
    expect(await (await call(env, '/health')).text()).toBe('ok');
    expect((await call(env, '/chat', { sessionId: 'w1', input: 'hi' })).status).toBe(401);

    const turn = await call(env, '/chat', { sessionId: 'w1', input: 'hi' }, { Authorization: 'Bearer tok' });
    expect(await turn.text()).toContain('This is a mock response.');
    expect(JSON.parse(kv.data.get('sessions/w1')!).map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    const transcript = await (await call(env, '/chat/w1', undefined, { Authorization: 'Bearer tok' })).json();
    expect(transcript.messages).toHaveLength(2);
  });

  it('checkpoints the deprecated { message, sessionId } run under checkpoints/<sessionId>', async () => {
    const kv = fakeKV();
    const response = await call({ AGENT_CHECKPOINTS: kv }, '/chat', { message: 'hi', sessionId: 'legacy-1' });
    expect((await response.json()).text).toBe('This is a mock response.');
    expect(kv.data.has('checkpoints/legacy-1')).toBe(true);
  });

  it('falls back to the memory of this isolate without a (valid) KV binding', async () => {
    for (const [id, env] of [['mem-1', {}], ['mem-2', { AGENT_CHECKPOINTS: 'not a namespace' }]] as const) {
      expect(workerStore(env)).toBe(workerStore({}));
      await (await call(env, '/chat', { sessionId: id, input: 'hi' })).text();
      expect((await (await call(env, `/chat/${id}`)).json()).messages).toHaveLength(2);
    }
    expect(workerStore({ AGENT_CHECKPOINTS: fakeKV() })).toBeInstanceOf(KVStore);
  });
});
