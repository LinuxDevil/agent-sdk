// @vitest-environment node
/**
 * LOU-P3: the Svelte loushoAgent() store driven through its subscribe()
 * contract (no DOM needed), in process with mockModel and remote with a
 * scripted fetch.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { AGENT_EVENT_SCHEMA_VERSION } from '../execution/agentEvents';
import type { AgentUIState } from '../ui';
import { loushoTodos } from './loushoTodos';
import { createTodoTools } from '../tools/built-in/todo';
import type { TodoView } from '../ui';
import { loushoAgent, type LoushoAgentStore } from './loushoAgent';

/** What `$agent` reads: the latest value the store handed to a subscriber. */
function watch(store: LoushoAgentStore) {
  let value!: AgentUIState;
  const unsubscribe = store.subscribe((state) => (value = state));
  return { state: () => value, unsubscribe };
}

function emailAgent(...turns: Parameters<typeof mockModel>[0]) {
  const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
  const tool = defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
  return { agent: createAgent({ provider: mockModel(turns), tools: [tool] }), execute };
}

const callEmail = { toolCalls: [{ name: 'send_email', args: { to: 'sam' }, id: 'call_email' }] };

describe('loushoAgent for Svelte (LOU-P3)', () => {
  it('calls a subscriber at once with the initial state, and streams the reply into it', async () => {
    const store = loushoAgent({ agent: createAgent({ provider: mockModel([{ text: 'Hello there!', usage: { inputTokens: 5, outputTokens: 3 } }]) }) });
    const seen: string[] = [];
    store.subscribe((state) => seen.push(state.status));
    expect(seen).toEqual(['idle']);

    await store.send('Hi');
    const { state } = watch(store);

    expect(seen).toContain('streaming');
    expect(state().status).toBe('idle');
    expect(state().messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello there!' },
    ]);
    expect(state().usage?.totalTokens).toBe(8);
    expect(state().lastEvent?.type).toBe('run.done');
    expect(state().error).toBeNull();
  });

  it('shows a tool call and its state through the approval round trip', async () => {
    const { agent, execute } = emailAgent(callEmail, 'Email sent.');
    const store = loushoAgent({ agent });
    const { state } = watch(store);

    await store.send('Email Sam');
    expect(state().status).toBe('awaiting-approval');
    expect(state().pendingApproval).toMatchObject({ toolName: 'send_email', args: { to: 'sam' } });
    expect(state().messages[1].toolCalls).toMatchObject([{ name: 'send_email', status: 'awaiting-approval' }]);

    await store.approve();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(state().pendingApproval).toBeNull();
    expect(state().messages[1]).toMatchObject({ text: 'Email sent.', toolCalls: [{ name: 'send_email', status: 'done' }] });
  });

  it('reject() marks the call rejected', async () => {
    const { agent, execute } = emailAgent(callEmail, 'OK, not sent.');
    const store = loushoAgent({ agent });
    const { state } = watch(store);
    await store.send('Email Sam');
    await store.reject('not today');
    expect(execute).not.toHaveBeenCalled();
    expect(state().messages[1]).toMatchObject({ text: 'OK, not sent.', toolCalls: [{ status: 'rejected' }] });
  });

  it('a failing run ends in the error status', async () => {
    const store = loushoAgent({ agent: createAgent({ provider: mockModel([{ error: new Error('provider down') }]) }) });
    const { state } = watch(store);
    await store.send('Hi');
    expect(state().status).toBe('error');
    expect(state().error?.message).toMatch(/provider down/);
  });

  it('reset() starts a new conversation and clears the state', async () => {
    const model = mockModel(['Nice to meet you, Ali.', 'Hello again']);
    const store = loushoAgent({ agent: createAgent({ provider: model }), sessionId: 'chat-1' });
    const { state } = watch(store);
    await store.send('My name is Ali.');
    store.reset();
    expect(state().messages).toEqual([]);
    await store.send('Hello again');
    expect(model.lastCall?.messages.some((m) => m.content === 'My name is Ali.')).toBe(false);
  });
});

describe('loushoAgent for Svelte remote and abort (LOU-P3)', () => {
  const base = { runId: 'r1', timestamp: new Date(0).toISOString(), v: AGENT_EVENT_SCHEMA_VERSION };
  const partial = `data: ${JSON.stringify({ ...base, seq: 0, type: 'text.delta', text: 'partial' })}\n\n`;

  /** A fetch whose response never ends; aborting the request errors it. */
  function openFetch() {
    const signals: AbortSignal[] = [];
    const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(partial));
          signal.addEventListener('abort', () => controller.error(signal.reason));
        },
      });
      return new Response(stream);
    };
    return { fetch: fetchMock as typeof fetch, signals };
  }

  it('stop() aborts the request and returns to idle', async () => {
    const remote = openFetch();
    const store = loushoAgent({ url: '/api/agent', fetch: remote.fetch });
    const { state } = watch(store);

    const sending = store.send('Long story');
    await vi.waitFor(() => expect(state().messages[1]?.text).toBe('partial'));
    store.stop();
    await sending;

    expect(remote.signals[0].aborted).toBe(true);
    expect(state().status).toBe('idle');
    expect(state().error).toBeNull();
  });

  it('aborts when the last subscriber unsubscribes, not before', async () => {
    const remote = openFetch();
    const store = loushoAgent({ url: '/api/agent', fetch: remote.fetch });
    const first = watch(store);
    const second = watch(store);

    const sending = store.send('Long story');
    await vi.waitFor(() => expect(first.state().messages[1]?.text).toBe('partial'));
    first.unsubscribe();
    expect(remote.signals[0].aborted).toBe(false);
    second.unsubscribe();
    await sending;

    expect(remote.signals[0].aborted).toBe(true);
  });

});

describe('loushoTodos (N12)', () => {
  const todoWrite = { name: 'todo_write', args: { todos: [{ content: 'Plan', status: 'completed' }, { content: 'Build', status: 'in_progress' }, { content: 'Ship', status: 'pending' }] } };
  const base = { runId: 'r1', timestamp: new Date(0).toISOString(), v: AGENT_EVENT_SCHEMA_VERSION };

  it('follows the todo list of an in-process run and notifies only when it changes', async () => {
    const store = loushoAgent({ agent: createAgent({ provider: mockModel([{ toolCalls: [todoWrite] }, 'done']), tools: createTodoTools().tools }) });
    const views: TodoView[] = [];
    const unsubscribe = loushoTodos(store).subscribe((view) => views.push(view));
    expect(views).toHaveLength(1);
    expect(views[0].todos).toEqual([]);

    await store.send('Go');

    expect(views).toHaveLength(2);
    expect(views[1].counts).toEqual({ pending: 1, in_progress: 1, completed: 1, total: 3 });
    expect(views[1].current?.content).toBe('Build');
    unsubscribe();
  });

  it('follows a remote run, which now also receives agent.drift', async () => {
    const events = [
  { ...base, seq: 0, type: 'run.start', agentName: 'a' },
  { ...base, seq: 1, type: 'agent.drift', model: { from: 'a', to: 'b' }, toolsAdded: [], toolsRemoved: [], instructions: false },
  { ...base, seq: 2, type: 'todo.updated', toolCallId: 'w1', todos: [{ id: 'todo_1', content: 'Plan', status: 'completed' }, { id: 'todo_2', content: 'Build', status: 'pending' }], counts: { pending: 1, in_progress: 0, completed: 1, total: 2 } },
  { ...base, seq: 3, type: 'run.done', finishReason: 'stop', text: '' },
];
    const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
    const store = loushoAgent({ url: '/api/agent', fetch: (async () => new Response(body)) as typeof fetch });
    let view!: TodoView;
    loushoTodos(store).subscribe((next) => (view = next));

    await store.send('Go');

    expect(view.counts).toEqual({ pending: 1, in_progress: 0, completed: 1, total: 2 });
    expect(view.progress).toBe(0.5);
    store.reset();
    expect(view.todos).toEqual([]);
  });
});
