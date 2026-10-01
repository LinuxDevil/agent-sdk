/**
 * LOU-V9: queued follow-up input - `run.enqueue()`, `ExecuteOptions.inputQueue`
 * and `agent.session({ turnPolicy: 'queue' })`.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools';
import { mockModel, type MockRequest } from '../testing';
import { memoryStore } from '../storage/agentStore';
import { textOf } from '../providers/content';
import type { Message } from '../providers';
import { AgentExecutor, PropagatingToolError } from './AgentExecutor';
import type { AgentEvent } from './agentEvents';
import { InputQueue } from './inputQueue';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** A tool that signals `started`, then waits for `release` (with `crashOnce`, its first run then dies). */
function gatedTool(options: { crashOnce?: boolean } = {}) {
  const started = deferred();
  const release = deferred();
  let runs = 0;
  const tool = defineTool({
    name: 'wait',
    description: 'waits',
    input: z.object({}),
    execute: async () => {
      started.resolve();
      await release.promise;
      if (options.crashOnce && ++runs === 1) throw new PropagatingToolError('process died');
      return 'waited';
    },
  });
  return { tool, started: started.promise, release: release.resolve };
}

const conversation = (messages: readonly Message[] | MockRequest['messages'] | undefined) =>
  (messages ?? []).filter((m) => m.role !== 'system').map((m) => `${m.role}:${textOf(m as Message)}`);

async function collect(run: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

describe('run.enqueue()', () => {
  it('applies input queued during a tool call before the next model call', async () => {
    const { tool, started, release } = gatedTool();
    const model = mockModel([{ toolCalls: [{ name: 'wait' }] }, 'Done, and noted.']);
    const run = createAgent({ provider: model, tools: [tool] }).stream('Start.');

    await started;
    const queued = run.enqueue('Also use metric units.');
    release();
    const events = await collect(run);

    expect(await queued.applied).toBe(true);
    expect(conversation(model.calls[1]?.messages)).toEqual([
      'user:Start.',
      'assistant:',
      'tool:"waited"',
      'user:Also use metric units.',
    ]);
    const result = await run.result;
    expect(conversation(result.messages).slice(-2)).toEqual(['user:Also use metric units.', 'assistant:Done, and noted.']);

    const types = events.map((e) => e.type);
    const at = (type: string) => types.indexOf(type as AgentEvent['type']);
    expect(at('tool.start')).toBeLessThan(at('input.queued'));
    expect(at('input.queued')).toBeLessThan(at('tool.done'));
    expect(at('step.done')).toBeLessThan(at('input.applied'));
    const applied = events[at('input.applied')];
    expect(applied).toMatchObject({ type: 'input.applied', id: queued.id, step: 2 });
    expect(events[at('input.applied') + 1]).toMatchObject({ type: 'step.start', step: 2 });
    expect(events[at('input.queued')]).toMatchObject({ id: queued.id, text: 'Also use metric units.' });
  });

  it('takes another step for input queued while the model gives its final reply', async () => {
    const replying = deferred();
    const release = deferred();
    const model = mockModel([
      async () => {
        replying.resolve();
        await release.promise;
        return 'First answer.';
      },
      'Second answer.',
    ]);
    const run = createAgent({ provider: model }).stream('Q1');

    await replying.promise;
    run.enqueue('Q2');
    release.resolve();
    const result = await run.result;

    expect(result.text).toBe('Second answer.');
    expect(conversation(result.messages)).toEqual(['user:Q1', 'assistant:First answer.', 'user:Q2', 'assistant:Second answer.']);
  });

  it('returns applied: false once the run has finished', async () => {
    const run = createAgent({ provider: mockModel(['hi']) }).stream('hello');
    await run.result;

    expect(run.enqueue('too late')).toEqual({ id: expect.any(String), applied: false });
  });

  it('resolves applied to false when the run is aborted first', async () => {
    const controller = new AbortController();
    const { tool, started, release } = gatedTool();
    const run = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'wait' }] }]), tools: [tool] }).stream('go', {
      signal: controller.signal,
    });

    await started;
    const queued = run.enqueue('never seen');
    controller.abort();
    release();

    expect(await queued.applied).toBe(false);
    expect((await run.result).finishReason).toBe('aborted');
  });
});

describe('ExecuteOptions.inputQueue', () => {
  it('lets a send()-style caller push input into a running execute()', async () => {
    const { tool, started, release } = gatedTool();
    const model = mockModel([{ toolCalls: [{ name: 'wait' }] }, 'ok']);
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerMany([tool]);
    const inputQueue = new InputQueue();

    const pending = AgentExecutor.execute({
      agent: { id: 'a', name: 'A', prompt: 'p', tools: { wait: { tool: 'wait' } } },
      provider: model,
      toolRegistry,
      input: 'Start.',
      inputQueue,
    });
    await started;
    const queued = inputQueue.push('More.');
    release();
    await pending;

    expect(await queued.applied).toBe(true);
    expect(conversation(model.calls[1]?.messages).at(-1)).toBe('user:More.');
    expect(inputQueue.push('after').applied).toBe(false);
  });
});

describe('durable queued input', () => {
  it('checkpoints a queued input, so a crash does not lose it', async () => {
    const store = memoryStore();
    const { tool, started, release } = gatedTool({ crashOnce: true });
    const model = mockModel([{ toolCalls: [{ name: 'wait' }] }, 'recovered']);
    const agent = createAgent({ provider: model, tools: [tool], store });
    const run = agent.stream('Start.', { sessionId: 'job-1' });

    await started;
    run.enqueue('Do not forget me.');
    await vi.waitFor(async () =>
      expect(conversation((await store.checkpoints.load('job-1'))?.messages).at(-1)).toBe('user:Do not forget me.')
    );
    release();
    await expect(run.result).rejects.toThrow('process died');

    const checkpoint = await store.checkpoints.load('job-1');
    expect(checkpoint?.status).toBe('in-progress');
    expect(conversation(checkpoint?.messages).at(-1)).toBe('user:Do not forget me.');

    // Resuming runs the unanswered tool call, then hands the model the queued input after its result.
    expect((await agent.resume('job-1'))?.text).toBe('recovered');
    expect(conversation(model.calls[1]?.messages)).toEqual([
      'user:Start.',
      'assistant:',
      'tool:"waited"',
      'user:Do not forget me.',
    ]);
  });
});

describe("agent.session({ turnPolicy: 'queue' })", () => {
  it('merges a send() made while a turn runs into that turn', async () => {
    const { tool, started, release } = gatedTool();
    const model = mockModel([{ toolCalls: [{ name: 'wait' }] }, 'Both handled.', 'Next turn.']);
    const session = createAgent({ provider: model, tools: [tool] }).session({ turnPolicy: 'queue' });

    const first = session.send('Start.');
    await started;
    const second = session.send('And this.');
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(b).toBe(a);
    expect(model.calls).toHaveLength(2);
    expect(conversation(session.messages)).toEqual([
      'user:Start.',
      'assistant:',
      'tool:"waited"',
      'user:And this.',
      'assistant:Both handled.',
    ]);

    await session.send('Later.');
    expect(conversation(model.calls[2]?.messages).at(-1)).toBe('user:Later.');
  });

  it('joins a turn that has not started yet, before its first model call', async () => {
    const model = mockModel(['Both at once.']);
    const session = createAgent({ provider: model }).session({ turnPolicy: 'queue' });

    const first = session.send('Find flights to Rome.');
    const second = session.send('Only direct ones.');

    expect(await second).toBe(await first);
    expect(conversation(model.calls[0]?.messages)).toEqual(['user:Find flights to Rome.', 'user:Only direct ones.']);
  });

  it('runs the input as its own turn when the running turn is aborted before taking it', async () => {
    const controller = new AbortController();
    const { tool, started, release } = gatedTool();
    const model = mockModel([{ toolCalls: [{ name: 'wait' }] }, 'Own turn.']);
    const session = createAgent({ provider: model, tools: [tool] }).session({ turnPolicy: 'queue' });

    const first = session.send('Start.', { signal: controller.signal });
    await started;
    const second = session.send('And this.');
    controller.abort();
    release();

    expect((await first).finishReason).toBe('aborted');
    expect((await second).text).toBe('Own turn.');
    expect(conversation(session.messages)).toEqual(['user:And this.', 'assistant:Own turn.']);
  });

  it('joins a running turn from stream() too', async () => {
    const { tool, started, release } = gatedTool();
    const model = mockModel([{ toolCalls: [{ name: 'wait' }] }, 'Both handled.']);
    const session = createAgent({ provider: model, tools: [tool] }).session({ turnPolicy: 'queue' });

    const first = session.stream('Start.');
    await started;
    const joined = session.stream('And this.');
    release();

    const events = await collect(joined);
    expect(events.at(-1)).toMatchObject({ type: 'run.done', text: 'Both handled.' });
    expect(await joined.result).toBe(await first.result);
    expect(conversation(session.messages).at(-2)).toBe('user:And this.');
  });

  it("keeps today's behaviour by default: a second send() waits for its own turn", async () => {
    const { tool, started, release } = gatedTool();
    const model = mockModel([{ toolCalls: [{ name: 'wait' }] }, 'One.', 'Two.']);
    const session = createAgent({ provider: model, tools: [tool] }).session();

    const first = session.send('Start.');
    await started;
    const second = session.send('And this.');
    release();

    expect((await first).text).toBe('One.');
    expect((await second).text).toBe('Two.');
    expect(model.calls).toHaveLength(3);
  });
});
