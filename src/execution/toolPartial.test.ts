/**
 * N13b: a tool whose `execute` is an `async function*` streams its output.
 * Every `yield` is a complete snapshot, reported as `tool.partial`; the last
 * one is the result. Snapshots never reach the model, the transcript, a
 * checkpoint or a trace span.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools';
import { mockModel, type MockTurn } from '../testing';
import { memoryStore } from '../storage/agentStore';
import { NoopSandbox } from '../security/sandboxCore';
import type { Span, TraceExporter } from './tracing';
import type { Message } from '../providers';
import { isAgentEvent, type AgentEvent, type AgentEventOf } from './agentEvents';
import type { ExecutionResult } from './AgentExecutor';
import { executeToolWithSandboxGuard } from './sandboxGuard';
import { drainPartialStream, isPartialStream } from './toolPartials';
import type { IoGuardrail, IoGuardrailResult } from './ioGuardrails';
import { defineOAuthProvider } from '../oauth/defineOAuthProvider';
import { fakeOAuthServer } from '../oauth/__fixtures__/fakeOAuth';

afterEach(() => vi.restoreAllMocks());

const ALICE = { id: 'alice', issuer: 'https://id.example.com' };

/** `count_to`: yields `{ at: i }` for each step, then `{ done: true, n }`. */
function countTo(onFinally?: () => void) {
  return defineTool({
    name: 'count_to',
    description: 'Counts to n, reporting progress',
    input: z.object({ n: z.number() }),
    async *execute({ n }) {
      try {
        for (let i = 1; i < n; i++) yield { at: i };
        yield { done: true, n };
      } finally {
        onFinally?.();
      }
    },
  });
}

const call = (name: string, args: Record<string, unknown>, id: string): MockTurn => ({ toolCalls: [{ name, args, id }] });

async function collect(run: AsyncIterable<AgentEvent> & { result: Promise<ExecutionResult> }) {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return { events, result: await run.result };
}

const ofType = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is AgentEventOf<T> => e.type === type);

const toolMessages = (messages: readonly Message[]) => messages.filter((m) => m.role === 'tool').map((m) => m.content);

describe('generator tools stream tool.partial (N13b)', () => {
  it('three yields: three tool.partial (index 0..2) between tool.start and tool.done; only the last reaches the model', async () => {
    const model = mockModel([call('count_to', { n: 3 }, 'call_1'), 'Counted.']);
    const agent = createAgent({ provider: model, tools: [countTo()] });

    const { events, result } = await collect(agent.stream('Count to 3.'));

    const toolEvents = events.filter((e) => e.type.startsWith('tool.'));
    expect(toolEvents.map((e) => e.type)).toEqual(['tool.start', 'tool.partial', 'tool.partial', 'tool.partial', 'tool.done']);
    expect(ofType(events, 'tool.partial').map(({ toolCallId, toolName, output, index }) => ({ toolCallId, toolName, output, index }))).toEqual([
      { toolCallId: 'call_1', toolName: 'count_to', output: { at: 1 }, index: 0 },
      { toolCallId: 'call_1', toolName: 'count_to', output: { at: 2 }, index: 1 },
      { toolCallId: 'call_1', toolName: 'count_to', output: { done: true, n: 3 }, index: 2 },
    ]);
    expect(ofType(events, 'tool.done')[0].result).toEqual({ done: true, n: 3 });
    // The model's next request carries the final result only.
    const sent = model.calls[1].messages.filter((m) => m.role === 'tool');
    expect(sent.map((m) => m.content)).toEqual([JSON.stringify({ done: true, n: 3 })]);
    expect(JSON.stringify(model.calls[1].messages)).not.toContain('"at"');
    expect(toolMessages(result.messages)).toEqual([JSON.stringify({ done: true, n: 3 })]);
    expect(events.every((e) => isAgentEvent(e))).toBe(true);
  });

  it('send() and the session transcript hold only the final result; nothing partial is checkpointed', async () => {
    const store = memoryStore();
    const saved: string[] = [];
    const save = store.checkpoints!.save.bind(store.checkpoints);
    vi.spyOn(store.checkpoints!, 'save').mockImplementation(async (sessionId, checkpoint) => {
      saved.push(JSON.stringify(checkpoint));
      return save(sessionId, checkpoint);
    });
    const partials: AgentEvent[] = [];
    const onEvent = (e: AgentEvent) => void (e.type === 'tool.partial' && partials.push(e));
    const agent = createAgent({ provider: mockModel([call('count_to', { n: 3 }, 'call_1'), 'Counted.']), tools: [countTo()], store, onEvent });

    const result = await agent.session({ id: 's1' }).send('Count to 3.');

    expect(partials).toHaveLength(3);
    expect(toolMessages(result.messages)).toEqual([JSON.stringify({ done: true, n: 3 })]);
    const transcript = (await store.sessions.load('s1')) ?? [];
    expect(transcript.length).toBeGreaterThan(0);
    expect(toolMessages(transcript)).toEqual([JSON.stringify({ done: true, n: 3 })]);
    expect(JSON.stringify(transcript)).not.toContain('\\"at\\"');
    // The checkpoint written after the call holds its final result, and no snapshot.
    expect(saved.join('\n')).toContain('\\"done\\":true');
    expect(saved.join('\n')).not.toContain('\\"at\\"');
  });

  it('a generator that throws after one yield: one tool.partial, then tool.error', async () => {
    const flaky = defineTool({
      name: 'flaky',
      description: 'Fails half way',
      input: z.object({}),
      async *execute() {
        yield { step: 1 };
        throw new Error('disk full');
      },
    });
    const agent = createAgent({ provider: mockModel([call('flaky', {}, 'call_1'), 'It failed.']), tools: [flaky] });

    const { events } = await collect(agent.stream('Go.'));

    expect(events.filter((e) => e.type.startsWith('tool.')).map((e) => e.type)).toEqual(['tool.start', 'tool.partial', 'tool.error']);
    expect(ofType(events, 'tool.error')[0].error.message).toContain('disk full');
  });

  it('aborting the run mid-generator runs its finally and settles the run as aborted', async () => {
    let finalized = false;
    let resume!: () => void;
    const slow = defineTool({
      name: 'slow',
      description: 'Takes a while',
      input: z.object({}),
      async *execute() {
        try {
          yield { step: 1 };
          await new Promise<void>((resolve) => (resume = resolve));
          yield { step: 2 };
        } finally {
          finalized = true;
        }
      },
    });
    const controller = new AbortController();
    const agent = createAgent({ provider: mockModel([call('slow', {}, 'call_1'), 'never']), tools: [slow] });

    const events: AgentEvent[] = [];
    const run = agent.stream('Go.', { signal: controller.signal });
    for await (const event of run) {
      events.push(event);
      if (event.type === 'tool.partial') controller.abort();
    }
    const result = await run.result;

    expect(result.finishReason).toBe('aborted');
    expect(ofType(events, 'tool.partial')).toHaveLength(1);
    // An async generator runs its finally once the await it is in settles.
    resume();
    await vi.waitFor(() => expect(finalized).toBe(true));
    expect(ofType(events, 'tool.partial')).toHaveLength(1);
  });

  it('a generator that yields nothing has a null result', async () => {
    const quiet = defineTool({
      name: 'quiet',
      description: 'Yields nothing',
      input: z.object({}),
      async *execute() {
        return 'ignored';
      },
    });
    const model = mockModel([call('quiet', {}, 'call_1'), 'Done.']);
    const agent = createAgent({ provider: model, tools: [quiet] });

    const { events } = await collect(agent.stream('Go.'));

    expect(ofType(events, 'tool.partial')).toEqual([]);
    expect(ofType(events, 'tool.done')[0].result).toBeNull();
  });

  it('parallel calls interleave their partials, each with its own toolCallId and index', async () => {
    const gates = new Map<string, () => void>();
    const stepper = defineTool({
      name: 'stepper',
      description: 'Steps when told',
      input: z.object({ name: z.string() }),
      async *execute({ name }) {
        for (let i = 0; i < 2; i++) {
          await new Promise<void>((resolve) => gates.set(`${name}${i}`, resolve));
          yield { name, i };
        }
      },
    });
    const turn: MockTurn = {
      toolCalls: [
        { name: 'stepper', args: { name: 'a' }, id: 'call_a' },
        { name: 'stepper', args: { name: 'b' }, id: 'call_b' },
      ],
    };
    const agent = createAgent({ provider: mockModel([turn, 'Both done.']), tools: [stepper] });

    const run = agent.stream('Go.');
    const done = collect(run);
    for (const key of ['a0', 'b0', 'b1', 'a1']) {
      await vi.waitFor(() => expect(gates.has(key)).toBe(true));
      gates.get(key)!();
    }
    const { events } = await done;

    expect(ofType(events, 'tool.partial').map((e) => [e.toolCallId, e.index, e.output])).toEqual([
      ['call_a', 0, { name: 'a', i: 0 }],
      ['call_b', 0, { name: 'b', i: 0 }],
      ['call_b', 1, { name: 'b', i: 1 }],
      ['call_a', 1, { name: 'a', i: 1 }],
    ]);
    expect(ofType(events, 'tool.done').map((e) => [e.toolCallId, e.result])).toEqual([
      ['call_b', { name: 'b', i: 1 }],
      ['call_a', { name: 'a', i: 1 }],
    ]);
  });

  it('toolConcurrency counts the whole generator run, not its first next()', async () => {
    const order: string[] = [];
    const stepper = defineTool({
      name: 'stepper',
      description: 'Two steps',
      input: z.object({ name: z.string() }),
      async *execute({ name }) {
        order.push(`${name}:start`);
        yield 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield 2;
        order.push(`${name}:end`);
      },
    });
    const turn: MockTurn = { toolCalls: [{ name: 'stepper', args: { name: 'a' } }, { name: 'stepper', args: { name: 'b' } }] };
    const agent = createAgent({ provider: mockModel([turn, 'ok']), tools: [stepper], toolConcurrency: 1 });

    await agent.send('Go.');

    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('a sub-agent tool streams its partials with the subagent field', async () => {
    const child = createAgent({ provider: mockModel([call('count_to', { n: 2 }, 'child_call'), 'child counted']), tools: [countTo()], description: 'Counts' });
    const taskCall: MockTurn = { toolCalls: [{ name: 'task', args: { agent: 'counter', prompt: 'count', description: 'count' }, id: 'call_task' }] };
    const lead = createAgent({ provider: mockModel([taskCall, 'Lead done.']), subagents: { counter: child } });

    const { events } = await collect(lead.stream('Delegate.'));

    const partials = ofType(events, 'tool.partial');
    expect(partials.map((e) => [e.toolCallId, e.index, e.subagent?.toolCallId])).toEqual([
      ['child_call', 0, 'call_task'],
      ['child_call', 1, 'call_task'],
    ]);
  });

  it('a blocking runInParallel input guardrail: the tool never starts, no partial leaks', async () => {
    let decide!: (result: IoGuardrailResult) => void;
    const gate: IoGuardrail = { name: 'gate', runInParallel: true, check: () => new Promise((resolve) => (decide = resolve)) };
    const model = mockModel([call('count_to', { n: 3 }, 'call_1'), 'never']);
    const agent = createAgent({ provider: model, tools: [countTo()], guardrails: { input: [gate] } });

    const run = agent.stream('bad input');
    const done = collect(run);
    await vi.waitFor(() => expect(model.calls).toHaveLength(1));
    decide({ ok: false, reason: 'no' });
    const { events, result } = await done;

    expect(result.finishReason).toBe('guardrail');
    expect(events.some((e) => e.type === 'tool.partial' || e.type === 'tool.start')).toBe(false);
  });

  it('isAgentEvent() accepts tool.partial', () => {
    expect(isAgentEvent({ type: 'tool.partial', toolCallId: 'c', toolName: 't', output: 1, index: 0, seq: 3, runId: 'r', timestamp: '', v: 1 })).toBe(true);
  });
});

describe('generator tools on the resume path (N13b)', () => {
  it('an approved generator tool streams its partials on the resumed run (approvals.streamResolve)', async () => {
    const tool = defineTool({
      name: 'count_to',
      description: 'Counts',
      input: z.object({ n: z.number() }),
      needsApproval: true,
      async *execute({ n }) {
        for (let i = 1; i <= n; i++) yield { at: i };
      },
    });
    const store = memoryStore();
    const agent = createAgent({ provider: mockModel([call('count_to', { n: 2 }, 'call_1'), 'Counted.']), tools: [tool], store });

    const paused = await collect(agent.stream('Count.'));
    expect(paused.result.finishReason).toBe('awaiting-approval');
    expect(ofType(paused.events, 'tool.partial')).toEqual([]);

    const resumed = await collect(agent.approvals.streamResolve({ id: paused.result.approvalId!, approved: true }));

    expect(resumed.events.filter((e) => e.type.startsWith('tool.')).map((e) => e.type)).toEqual(['tool.start', 'tool.partial', 'tool.partial', 'tool.done']);
    expect(ofType(resumed.events, 'tool.partial').map((e) => [e.toolCallId, e.index, e.output])).toEqual([
      ['call_1', 0, { at: 1 }],
      ['call_1', 1, { at: 2 }],
    ]);
    expect(resumed.result.text).toBe('Counted.');
    expect(toolMessages(resumed.result.messages)).toEqual([JSON.stringify({ at: 2 })]);
  });

  it('a generator that needs sign-in mid-stream pauses; after sign-in it runs again from the start (index 0); tokens are redacted from partials', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const server = fakeOAuthServer();
    const github = defineOAuthProvider({
      name: 'github',
      authorizationUrl: 'https://github.example.com/login/oauth/authorize',
      tokenUrl: 'https://github.example.com/login/oauth/access_token',
      clientId: 'client-123',
      redirectUri: 'https://agent.example.com/api/agent/oauth/callback',
      fetch: server.fetch,
    });
    let runs = 0;
    const repos = defineTool({
      name: 'list_repos',
      description: 'Lists repositories',
      input: z.object({}),
      async *execute(_args, ctx) {
        runs++;
        yield { status: 'connecting' };
        const { accessToken } = await ctx.getToken(github);
        yield { status: 'listing', debug: `token=${accessToken}` };
        yield { repos: ['lousho-demo'] };
      },
    });
    const store = memoryStore();
    const turn = call('list_repos', {}, 'call_1');
    const agent = createAgent({ provider: mockModel([turn, 'You have lousho-demo.']), tools: [repos], store });

    const paused = await collect(agent.stream('List my repos.', { principal: ALICE }));
    expect(paused.result.finishReason).toBe('awaiting-approval');
    expect(ofType(paused.events, 'tool.partial').map((e) => e.output)).toEqual([{ status: 'connecting' }]);
    expect(ofType(paused.events, 'tool.done')).toEqual([]);
    const approval = ofType(paused.events, 'approval.requested')[0];
    expect(approval.kind).toBe('sign-in');

    const state = new URL(approval.signIn?.url ?? '').searchParams.get('state') ?? '';
    await agent.oauth.complete({ state, code: 'code-alice' });
    const resumed = await collect(agent.approvals.streamResolve({ id: approval.approvalId, approved: true }));

    expect(runs).toBe(2);
    const partials = ofType(resumed.events, 'tool.partial');
    expect(partials.map((e) => [e.index, e.output])).toEqual([
      [0, { status: 'connecting' }],
      [1, { status: 'listing', debug: 'token=[REDACTED]' }],
      [2, { repos: ['lousho-demo'] }],
    ]);
    expect(JSON.stringify(resumed.events)).not.toContain('gho_SECRET');
    expect(toolMessages(resumed.result.messages)).toEqual([JSON.stringify({ repos: ['lousho-demo'] })]);
  });
});

describe('the partial-stream runner (N13b)', () => {
  it('only an async iterator that is also async iterable streams (a ReadableStream-like value is a result)', () => {
    async function* gen() {
      yield 1;
    }
    expect(isPartialStream(gen())).toBe(true);
    expect(isPartialStream({ [Symbol.asyncIterator]: () => gen() })).toBe(false);
    expect(isPartialStream({ next: () => Promise.resolve({ done: true, value: undefined }) })).toBe(false);
    expect(isPartialStream(null)).toBe(false);
    expect(isPartialStream('text')).toBe(false);
  });

  it('without a listener (flows, a run with no events) the generator is drained and its last yield is the result', async () => {
    const registry = new ToolRegistry();
    registry.register(countTo());
    const result = await executeToolWithSandboxGuard('count_to', registry.get('count_to')!, { n: 3 }, NoopSandbox);
    expect(result).toEqual({ done: true, n: 3 });
  });

  it('a value with Symbol.asyncIterator but no next() is returned as the result, unread', async () => {
    const iterable = { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
    const tool = defineTool({ name: 'raw', description: 'd', input: z.object({}), execute: () => iterable });
    expect(await executeToolWithSandboxGuard('raw', tool, {}, NoopSandbox)).toBe(iterable);
  });

  it('closes the generator when the snapshot listener throws', async () => {
    let closed = false;
    async function* gen() {
      try {
        yield 1;
        yield 2;
      } finally {
        closed = true;
      }
    }
    await expect(
      drainPartialStream(gen(), () => {
        throw new Error('listener failed');
      })
    ).rejects.toThrow('listener failed');
    expect(closed).toBe(true);
  });

  it('an already aborted signal stops before the first next()', async () => {
    let started = false;
    async function* gen() {
      started = true;
      yield 1;
    }
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(drainPartialStream(gen(), () => undefined, controller.signal)).rejects.toThrow('stop');
    expect(started).toBe(false);
  });
});

describe('partials and traces (N13b)', () => {
  it('a tool span records the final result only, never a snapshot', async () => {
    const spans: Span[] = [];
    const exporter: TraceExporter = { onSpanStart: (span) => spans.push(span), onSpanEnd: () => undefined };
    const agent = createAgent({ provider: mockModel([call('count_to', { n: 3 }, 'call_1'), 'Counted.']), tools: [countTo()], exporter, captureContent: true });

    await collect(agent.stream('Count.'));

    const toolSpan = spans.find((span) => span.name.includes('count_to'));
    expect(toolSpan).toBeDefined();
    const recorded = JSON.stringify(toolSpan?.attributes);
    expect(recorded).toContain('done');
    expect(recorded).not.toContain('\\"at\\"');
  });
});
