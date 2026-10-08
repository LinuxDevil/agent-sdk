// @vitest-environment node
/**
 * LOU-D15: useLoushoAgent() rendered with react-test-renderer (no DOM
 * needed), in process with mockModel and remote with a scripted fetch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { createTodoTools } from '../tools/built-in/todo';
import { AGENT_EVENT_SCHEMA_VERSION, type AgentEvent } from '../execution/agentEvents';
import { useTodos } from './useTodos';
import { useLoushoAgent, type LoushoAgentSource, type UseLoushoAgentOptions, type UseLoushoAgentResult } from './useLoushoAgent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let hook: UseLoushoAgentResult;
let renderer: ReactTestRenderer | undefined;
const statuses: string[] = [];

let todoView: ReturnType<typeof useTodos>;
const todoViews: unknown[] = [];

function Probe({ source, options }: { source: LoushoAgentSource; options?: UseLoushoAgentOptions }) {
  hook = useLoushoAgent(source, options);
  todoView = useTodos(hook);
  todoViews.push(todoView);
  statuses.push(hook.status);
  return null;
}

function mount(source: LoushoAgentSource, options?: UseLoushoAgentOptions): void {
  statuses.length = 0;
  act(() => {
    renderer = create(createElement(Probe, { source, options }));
  });
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

function emailAgent(...turns: Parameters<typeof mockModel>[0]) {
  const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
  const tool = defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
  return { agent: createAgent({ provider: mockModel(turns), tools: [tool] }), execute };
}

const callEmail = { toolCalls: [{ name: 'send_email', args: { to: 'sam' }, id: 'call_email' }] };

describe('useLoushoAgent in process (LOU-D15)', () => {
  it('send(parts) sends one user message with the parts and shows their text and a marker (LOU-V12)', async () => {
    const model = mockModel(['A cat.']);
    mount({ agent: createAgent({ provider: model }) });
    const parts = [
      { type: 'text' as const, text: 'What is this?' },
      { type: 'image' as const, image: 'https://example.com/cat.png' },
    ];

    await act(() => hook.send(parts));

    expect(hook.messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'What is this? [image]' },
      { role: 'assistant', text: 'A cat.' },
    ]);
    expect(model.calls[0].messages.filter((m) => m.role === 'user')).toEqual([{ role: 'user', content: parts }]);
  });

  it('send() streams the reply into messages and ends idle with usage', async () => {
    const agent = createAgent({ provider: mockModel([{ text: 'Hello there!', usage: { inputTokens: 5, outputTokens: 3 } }]) });
    mount({ agent });
    expect(hook.status).toBe('idle');

    await act(() => hook.send('Hi'));

    expect(statuses).toContain('streaming');
    expect(hook.status).toBe('idle');
    expect(hook.messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello there!' },
    ]);
    expect(hook.usage?.totalTokens).toBe(8);
    expect(hook.lastEvent?.type).toBe('run.done');
    expect(hook.error).toBeNull();
  });

  it('with sessionId, turns share one session', async () => {
    const model = mockModel(['Nice to meet you, Ali.', 'You are Ali.']);
    mount({ agent: createAgent({ provider: model }), sessionId: 'chat-1' });

    await act(() => hook.send('My name is Ali.'));
    await act(() => hook.send('What is my name?'));

    expect(model.lastCall?.messages.some((m) => m.content === 'My name is Ali.')).toBe(true);
    expect(hook.messages.map((m) => m.text)).toEqual(['My name is Ali.', 'Nice to meet you, Ali.', 'What is my name?', 'You are Ali.']);
  });

  it('pauses for approval and approve() continues the run through agent.approvals', async () => {
    const { agent, execute } = emailAgent(callEmail, 'Email sent.');
    mount({ agent });

    await act(() => hook.send('Email Sam'));
    expect(hook.status).toBe('awaiting-approval');
    expect(hook.pendingApproval).toMatchObject({ toolName: 'send_email', args: { to: 'sam' } });

    await act(() => hook.approve());

    expect(execute).toHaveBeenCalledTimes(1);
    expect(hook.status).toBe('idle');
    expect(hook.pendingApproval).toBeNull();
    expect(hook.messages[1]).toMatchObject({ text: 'Email sent.', toolCalls: [{ name: 'send_email', status: 'done' }] });
  });

  it("answer(text) answers an ask_question pause (LOU-X9)", async () => {
    const ask = { toolCalls: [{ name: 'ask_question', args: { question: 'Which city?', options: ['Porto', 'Lisbon'] }, id: 'call_q' }] };
    const model = mockModel([ask, 'Booking Lisbon.']);
    mount({ agent: createAgent({ provider: model, askQuestion: true }) });

    await act(() => hook.send('Book a trip'));
    expect(hook.pendingApproval).toMatchObject({
      kind: 'question',
      question: { text: 'Which city?', options: ['Porto', 'Lisbon'] },
    });

    await act(() => hook.answer('Lisbon'));

    expect(hook.status).toBe('idle');
    expect(hook.messages[1]).toMatchObject({ text: 'Booking Lisbon.', toolCalls: [{ name: 'ask_question', status: 'done' }] });
    const result = model.lastCall?.messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_q');
    expect(JSON.parse(result?.content as string)).toEqual({ answer: 'Lisbon', option: 1 });
  });

  it('reject() gives the model a rejection and marks the call rejected', async () => {
    const { agent, execute } = emailAgent(callEmail, 'OK, not sent.');
    mount({ agent });

    await act(() => hook.send('Email Sam'));
    await act(() => hook.reject('not today'));

    expect(execute).not.toHaveBeenCalled();
    expect(hook.status).toBe('idle');
    expect(hook.messages[1]).toMatchObject({ text: 'OK, not sent.', toolCalls: [{ status: 'rejected' }] });
  });

  it('a failing run ends in the error status', async () => {
    mount({ agent: createAgent({ provider: mockModel([{ error: new Error('provider down') }]) }) });
    await act(() => hook.send('Hi'));
    expect(hook.status).toBe('error');
    expect(hook.error?.message).toMatch(/provider down/);
  });
});

const base = { runId: 'r1', timestamp: new Date(0).toISOString(), v: AGENT_EVENT_SCHEMA_VERSION };
const sse = (events: AgentEvent[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

/** A fetch whose response body streams `body` and, unless `close` is false, ends; aborting the request errors it. */
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

describe('useLoushoAgent remote (LOU-D15)', () => {
  it('POSTs { input } with headers and reads the SSE event stream', async () => {
    const remote = scriptedFetch([
      {
        body: sse([
          { ...base, seq: 0, type: 'run.start', agentName: 'a' },
          { ...base, seq: 1, type: 'text.delta', text: 'Hi from the server' },
          { ...base, seq: 2, type: 'run.done', finishReason: 'stop', text: 'Hi from the server' },
        ]),
      },
    ]);
    mount({ url: '/api/agent', headers: { Authorization: 'Bearer t' }, fetch: remote.fetch });

    await act(() => hook.send('Hello'));

    const [url, init] = remote.fetchMock.mock.calls[0];
    expect(url).toBe('/api/agent');
    expect(init).toMatchObject({ method: 'POST', body: expect.stringMatching(/^{"input":"Hello","sessionId":"[^"]+"}$/), headers: { Authorization: 'Bearer t' } });
    expect(hook.status).toBe('idle');
    expect(hook.messages[1].text).toBe('Hi from the server');
  });

  it('approve() POSTs to approvalsUrl and applies the outcome; without it, it does nothing', async () => {
    const paused = sse([
      { ...base, seq: 0, type: 'approval.requested', approvalId: 'ap 1', toolCallId: 'c1', toolName: 'pay', args: {} },
      { ...base, seq: 1, type: 'run.done', finishReason: 'awaiting-approval', text: '' },
    ]);
    const remote = scriptedFetch([{ body: paused }, { body: JSON.stringify({ text: 'Paid.', finishReason: 'stop' }) }, { body: paused }]);
    mount({ url: '/api/agent', fetch: remote.fetch }, { approvalsUrl: '/api/approvals' });

    await act(() => hook.send('Pay'));
    expect(hook.status).toBe('awaiting-approval');
    await act(() => hook.approve('ok'));

    expect(remote.fetchMock.mock.calls[1][0]).toBe('/api/approvals/ap%201');
    expect(remote.fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify({ approved: true, note: 'ok' }));
    expect(hook.status).toBe('idle');
    expect(hook.messages[1].text).toBe('Paid.');

    act(() => renderer?.unmount());
    mount({ url: '/api/agent', fetch: remote.fetch });
    await act(() => hook.send('Pay'));
    await act(() => hook.approve());
    expect(remote.fetchMock).toHaveBeenCalledTimes(3);
    expect(hook.status).toBe('awaiting-approval');
  });

  it('a failed response sets the error status', async () => {
    mount({ url: '/api/agent', fetch: scriptedFetch([{ body: 'nope', status: 500 }]).fetch });
    await act(() => hook.send('Hi'));
    expect(hook.status).toBe('error');
    expect(hook.error?.message).toMatch(/500/);
  });

  it('stop() aborts the request and returns to idle; unmount aborts too', async () => {
    const open = sse([{ ...base, seq: 0, type: 'text.delta', text: 'partial' }]);
    const remote = scriptedFetch([{ body: open, close: false }, { body: open, close: false }]);
    mount({ url: '/api/agent', fetch: remote.fetch });

    let sending: Promise<void> = Promise.resolve();
    act(() => {
      sending = hook.send('Long story');
    });
    await act(() => vi.waitFor(() => expect(hook.messages[1]?.text).toBe('partial')));
    expect(hook.status).toBe('streaming');
    await act(async () => {
      hook.stop();
      await sending;
    });
    expect(remote.signals[0].aborted).toBe(true);
    expect(hook.status).toBe('idle');
    expect(hook.error).toBeNull();

    act(() => {
      void hook.send('Again');
    });
    await act(() => vi.waitFor(() => expect(remote.signals).toHaveLength(2)));
    act(() => renderer?.unmount());
    renderer = undefined;
    expect(remote.signals[1].aborted).toBe(true);
  });

});

describe('useTodos (N12)', () => {
  const todoWrite = { name: 'todo_write', args: { todos: [{ content: 'Plan', status: 'completed' }, { content: 'Build', status: 'in_progress' }, { content: 'Ship', status: 'pending' }] } };

  it('follows the todo list of an in-process run, with counts, the current item and progress', async () => {
    const todos = createTodoTools();
    mount({ agent: createAgent({ provider: mockModel([{ toolCalls: [todoWrite] }, 'done']), tools: todos.tools }) });
    expect(todoView.todos).toEqual([]);
    expect(todoView.progress).toBe(0);

    await act(() => hook.send('Go'));

    expect(todoView.counts).toEqual({ pending: 1, in_progress: 1, completed: 1, total: 3 });
    expect(todoView.current?.content).toBe('Build');
    expect(todoView.progress).toBeCloseTo(1 / 3);
    expect(hook.todos).toBe(todoView.todos);
    // memoized: an unrelated state change keeps the same view object
    const before = todoView;
    act(() => hook.stop());
    expect(todoView).toBe(before);
  });

  it('follows a remote run, which now also receives agent.drift', async () => {
    const remote = scriptedFetch([{ body: sse([
  { ...base, seq: 0, type: 'run.start', agentName: 'a' },
  { ...base, seq: 1, type: 'agent.drift', model: { from: 'a', to: 'b' }, toolsAdded: [], toolsRemoved: [], toolsChanged: [], instructions: false },
  { ...base, seq: 2, type: 'todo.updated', toolCallId: 'w1', todos: [{ id: 'todo_1', content: 'Plan', status: 'completed' }, { id: 'todo_2', content: 'Build', status: 'pending' }], counts: { pending: 1, in_progress: 0, completed: 1, total: 2 } },
  { ...base, seq: 3, type: 'run.done', finishReason: 'stop', text: '' },
]) }]);
    mount({ url: '/api/agent', fetch: remote.fetch });

    await act(() => hook.send('Go'));

    expect(todoView.counts).toEqual({ pending: 1, in_progress: 0, completed: 1, total: 2 });
    expect(todoView.current?.content).toBe('Build');
  });
});
