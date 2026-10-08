// @vitest-environment node
/**
 * LOU-P2: the Vue useLoushoAgent() run inside an effectScope (no DOM needed),
 * in process with mockModel and remote with a scripted fetch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { effectScope, ref, type EffectScope, type Ref } from 'vue';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { createTodoTools } from '../tools/built-in/todo';
import { AGENT_EVENT_SCHEMA_VERSION, type AgentEvent } from '../execution/agentEvents';
import { useTodos } from './useTodos';
import { useLoushoAgent, type LoushoAgentSource, type UseLoushoAgentOptions, type UseLoushoAgentResult } from './useLoushoAgent';

let scope: EffectScope | undefined;

function mount(source: LoushoAgentSource | Ref<LoushoAgentSource>, options?: UseLoushoAgentOptions): UseLoushoAgentResult {
  scope = effectScope();
  return scope.run(() => useLoushoAgent(source, options)) as UseLoushoAgentResult;
}

afterEach(() => {
  scope?.stop();
  scope = undefined;
});

function emailAgent(...turns: Parameters<typeof mockModel>[0]) {
  const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
  const tool = defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
  return { agent: createAgent({ provider: mockModel(turns), tools: [tool] }), execute };
}

const callEmail = { toolCalls: [{ name: 'send_email', args: { to: 'sam' }, id: 'call_email' }] };
const base = { runId: 'r1', timestamp: new Date(0).toISOString(), v: AGENT_EVENT_SCHEMA_VERSION };
const sse = (events: AgentEvent[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

/** A fetch whose body streams `body` and, unless `close` is false, ends; aborting the request errors it. */
function scriptedFetch(responses: { body: string; close?: boolean; status?: number }[]) {
  const signals: AbortSignal[] = [];
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { body, close = true, status = 200 } = responses.shift() ?? { body: '' };
    const signal = init?.signal ?? new AbortController().signal;
    signals.push(signal);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        if (close) controller.close();
        else signal.addEventListener('abort', () => controller.error(signal.reason));
      },
    });
    return new Response(stream, { status });
  });
  return { fetch: fetchMock as unknown as typeof fetch, fetchMock, signals };
}

describe('useLoushoAgent for Vue in process (LOU-P2)', () => {
  it('send() streams the reply into messages and ends idle with usage', async () => {
    const chat = mount({ agent: createAgent({ provider: mockModel([{ text: 'Hello there!', usage: { inputTokens: 5, outputTokens: 3 } }]) }) });
    expect(chat.status.value).toBe('idle');

    const sending = chat.send('Hi');
    expect(chat.status.value).toBe('streaming');
    await sending;

    expect(chat.status.value).toBe('idle');
    expect(chat.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello there!' },
    ]);
    expect(chat.usage.value?.totalTokens).toBe(8);
    expect(chat.lastEvent.value?.type).toBe('run.done');
    expect(chat.error.value).toBeNull();
  });

  it('send(parts) shows the text and a marker for other parts', async () => {
    const chat = mount({ agent: createAgent({ provider: mockModel(['A cat.']) }) });
    await chat.send([
      { type: 'text', text: 'What is this?' },
      { type: 'image', image: 'https://example.com/cat.png' },
    ]);
    expect(chat.messages.value[0].text).toBe('What is this? [image]');
  });

  it('renders a tool call and its state, with the approval round trip', async () => {
    const { agent, execute } = emailAgent(callEmail, 'Email sent.');
    const chat = mount({ agent });

    await chat.send('Email Sam');
    expect(chat.status.value).toBe('awaiting-approval');
    expect(chat.pendingApproval.value).toMatchObject({ toolName: 'send_email', args: { to: 'sam' } });
    expect(chat.messages.value[1].toolCalls).toMatchObject([{ name: 'send_email', status: 'awaiting-approval' }]);

    await chat.approve();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(chat.status.value).toBe('idle');
    expect(chat.pendingApproval.value).toBeNull();
    expect(chat.messages.value[1]).toMatchObject({ text: 'Email sent.', toolCalls: [{ name: 'send_email', status: 'done' }] });
  });

  it('reject() marks the call rejected; answer() answers a question', async () => {
    const { agent, execute } = emailAgent(callEmail, 'OK, not sent.');
    const chat = mount({ agent });
    await chat.send('Email Sam');
    await chat.reject('not today');
    expect(execute).not.toHaveBeenCalled();
    expect(chat.messages.value[1]).toMatchObject({ text: 'OK, not sent.', toolCalls: [{ status: 'rejected' }] });

    const ask = { toolCalls: [{ name: 'ask_question', args: { question: 'Which city?' }, id: 'call_q' }] };
    const asking = mount({ agent: createAgent({ provider: mockModel([ask, 'Booking Lisbon.']), askQuestion: true }) });
    await asking.send('Book a trip');
    expect(asking.pendingApproval.value).toMatchObject({ kind: 'question', question: { text: 'Which city?' } });
    await asking.answer('Lisbon');
    expect(asking.messages.value[1]).toMatchObject({ text: 'Booking Lisbon.', toolCalls: [{ status: 'done' }] });
  });

  it('a failing run ends in the error status', async () => {
    const chat = mount({ agent: createAgent({ provider: mockModel([{ error: new Error('provider down') }]) }) });
    await chat.send('Hi');
    expect(chat.status.value).toBe('error');
    expect(chat.error.value?.message).toMatch(/provider down/);
  });

  it('with sessionId turns share one session, and reset() starts over', async () => {
    const model = mockModel(['Nice to meet you, Ali.', 'You are Ali.', 'Who?']);
    const chat = mount({ agent: createAgent({ provider: model }), sessionId: 'chat-1' });
    await chat.send('My name is Ali.');
    await chat.send('What is my name?');
    expect(model.lastCall?.messages.some((m) => m.content === 'My name is Ali.')).toBe(true);

    chat.reset();
    expect(chat.messages.value).toEqual([]);
    expect(chat.status.value).toBe('idle');
    await chat.send('Hello again');
    expect(model.lastCall?.messages.some((m) => m.content === 'My name is Ali.')).toBe(false);
  });

  it('reads a ref source when a turn starts', async () => {
    const source = ref<LoushoAgentSource>({ agent: createAgent({ provider: mockModel(['first']) }) });
    const chat = mount(source);
    await chat.send('a');
    source.value = { agent: createAgent({ provider: mockModel(['second']) }) };
    await chat.send('b');
    expect(chat.messages.value.at(-1)?.text).toBe('second');
  });
});

describe('useLoushoAgent for Vue remote (LOU-P2)', () => {
  it('POSTs { input } with headers, reads the stream and applies approval outcomes', async () => {
    const paused = sse([
      { ...base, seq: 0, type: 'approval.requested', approvalId: 'ap 1', toolCallId: 'c1', toolName: 'pay', args: {} },
      { ...base, seq: 1, type: 'run.done', finishReason: 'awaiting-approval', text: '' },
    ]);
    const remote = scriptedFetch([{ body: paused }, { body: JSON.stringify({ text: 'Paid.', finishReason: 'stop' }) }]);
    const chat = mount({ url: '/api/agent', headers: { Authorization: 'Bearer t' }, fetch: remote.fetch }, { approvalsUrl: '/api/approvals' });

    await chat.send('Pay');
    expect(remote.fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: expect.stringMatching(/^{"input":"Pay","sessionId":"[^"]+"}$/), headers: { Authorization: 'Bearer t' } });
    expect(chat.status.value).toBe('awaiting-approval');
    await chat.approve('ok');

    expect(remote.fetchMock.mock.calls[1][0]).toBe('/api/approvals/ap%201');
    expect(chat.status.value).toBe('idle');
    expect(chat.messages.value[1].text).toBe('Paid.');
  });

  it('a failed response sets the error status', async () => {
    const chat = mount({ url: '/api/agent', fetch: scriptedFetch([{ body: 'nope', status: 500 }]).fetch });
    await chat.send('Hi');
    expect(chat.status.value).toBe('error');
    expect(chat.error.value?.message).toMatch(/500/);
  });

  it('stop() aborts the request and returns to idle', async () => {
    const open = sse([{ ...base, seq: 0, type: 'text.delta', text: 'partial' }]);
    const remote = scriptedFetch([{ body: open, close: false }]);
    const chat = mount({ url: '/api/agent', fetch: remote.fetch });

    const sending = chat.send('Long story');
    await vi.waitFor(() => expect(chat.messages.value[1]?.text).toBe('partial'));
    chat.stop();
    await sending;

    expect(remote.signals[0].aborted).toBe(true);
    expect(chat.status.value).toBe('idle');
    expect(chat.error.value).toBeNull();
  });

  it('disposing the scope aborts the request in flight', async () => {
    const open = sse([{ ...base, seq: 0, type: 'text.delta', text: 'partial' }]);
    const remote = scriptedFetch([{ body: open, close: false }]);
    const chat = mount({ url: '/api/agent', fetch: remote.fetch });

    const sending = chat.send('Long story');
    await vi.waitFor(() => expect(chat.messages.value[1]?.text).toBe('partial'));
    scope?.stop();
    await sending;

    expect(remote.signals[0].aborted).toBe(true);
  });

});

describe('useTodos (N12)', () => {
  const todoWrite = { name: 'todo_write', args: { todos: [{ content: 'Plan', status: 'completed' }, { content: 'Build', status: 'in_progress' }, { content: 'Ship', status: 'pending' }] } };

  it('follows the todo list of an in-process run', async () => {
    const chat = mount({ agent: createAgent({ provider: mockModel([{ toolCalls: [todoWrite] }, 'done']), tools: createTodoTools().tools }) });
    const plan = useTodos(chat);
    expect(plan.todos.value).toEqual([]);

    await chat.send('Go');

    expect(plan.counts.value).toEqual({ pending: 1, in_progress: 1, completed: 1, total: 3 });
    expect(plan.current.value?.content).toBe('Build');
    expect(plan.progress.value).toBeCloseTo(1 / 3);
    expect(chat.todos.value).toBe(plan.todos.value);
  });

  it('follows a remote run, which now also receives agent.drift, and clears on reset()', async () => {
    const remote = scriptedFetch([{ body: sse([
  { ...base, seq: 0, type: 'run.start', agentName: 'a' },
  { ...base, seq: 1, type: 'agent.drift', model: { from: 'a', to: 'b' }, toolsAdded: [], toolsRemoved: [], toolsChanged: [], instructions: false },
  { ...base, seq: 2, type: 'todo.updated', toolCallId: 'w1', todos: [{ id: 'todo_1', content: 'Plan', status: 'completed' }, { id: 'todo_2', content: 'Build', status: 'pending' }], counts: { pending: 1, in_progress: 0, completed: 1, total: 2 } },
  { ...base, seq: 3, type: 'run.done', finishReason: 'stop', text: '' },
]) }]);
    const chat = mount({ url: '/api/agent', fetch: remote.fetch });
    const plan = useTodos(chat);

    await chat.send('Go');
    expect(plan.counts.value).toEqual({ pending: 1, in_progress: 0, completed: 1, total: 2 });

    chat.reset();
    expect(plan.todos.value).toEqual([]);
    expect(plan.current.value).toBeUndefined();
  });
});
