/**
 * LOU-V10: steering - `run.steer()`, `InputQueue.steer()` and
 * `agent.session({ turnPolicy: 'steer' })`.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockModel, type MockRequest } from '../testing';
import { memoryStore } from '../storage/agentStore';
import { textOf } from '../providers/content';
import type { LLMProvider, Message, StreamResult } from '../providers';
import { AgentExecutor } from './AgentExecutor';
import type { AgentEvent } from './agentEvents';
import { InputQueue } from './inputQueue';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** A model turn that signals `calling`, then holds its reply until `release()`. */
function slowTurn(text: string) {
  const calling = deferred();
  const released = deferred();
  const turn = async () => {
    calling.resolve();
    await released.promise;
    return text;
  };
  return { turn, calling: calling.promise, release: released.resolve };
}

/** `model`, whose first streamed reply emits its first text chunk, then waits for `release()`. */
function textFirst(model: MockModel) {
  const emitted = deferred();
  const released = deferred();
  let first = true;
  const provider: LLMProvider = Object.assign(Object.create(model) as MockModel, {
    async stream(request: Parameters<LLMProvider['stream']>[0]): Promise<StreamResult> {
      const streamed = await model.stream(request);
      if (!first) return streamed;
      first = false;
      const fullStream = async function* () {
        for await (const chunk of streamed.fullStream) {
          yield chunk;
          if (chunk.type === 'text-delta') {
            emitted.resolve();
            await released.promise;
          }
        }
      };
      return { ...streamed, fullStream: fullStream() };
    },
  });
  return { provider, emitted: emitted.promise, release: released.resolve };
}

/** A tool that signals `started`, then waits for `release`. */
function gatedTool() {
  const started = deferred();
  const release = deferred();
  const tool = defineTool({
    name: 'wait',
    description: 'waits',
    input: z.object({}),
    execute: async () => {
      started.resolve();
      await release.promise;
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

describe('run.steer()', () => {
  it('aborts a model call that has not emitted anything and calls the model once more with the input', async () => {
    const slow = slowTurn('Rome it is.');
    const model = mockModel([slow.turn, 'Paris it is.']);
    const run = createAgent({ provider: model }).stream('Plan a trip to Rome.');

    await slow.calling;
    const steered = run.steer('Actually, make it Paris.');
    const events = await collect(run);
    slow.release(); // the discarded call's reply arrives too late to matter

    expect(steered).toMatchObject({ id: expect.any(String), applied: 'immediate' });
    expect(await steered.joined).toBe(true);
    expect(model.calls).toHaveLength(2);
    expect(conversation(model.calls[1]?.messages)).toEqual(['user:Plan a trip to Rome.', 'user:Actually, make it Paris.']);
    const result = await run.result;
    expect(result.text).toBe('Paris it is.');
    expect(conversation(result.messages)).toEqual([
      'user:Plan a trip to Rome.',
      'user:Actually, make it Paris.',
      'assistant:Paris it is.',
    ]);

    const relevant = events.filter((e) => e.type.startsWith('step.') || e.type.startsWith('input.') || e.type.startsWith('text.'));
    expect(relevant.map((e) => e.type)).toEqual([
      'step.start',
      'input.steered',
      'step.done',
      'input.applied',
      'step.start',
      'text.delta',
      'text.delta',
      'text.delta',
      'text.done',
      'step.done',
    ]);
    expect(relevant[1]).toMatchObject({ id: steered.id, text: 'Actually, make it Paris.', mode: 'immediate' });
    expect(relevant[2]).toMatchObject({ step: 1, finishReason: 'steered' });
    expect(relevant[3]).toMatchObject({ id: steered.id, step: 2 });
    expect(events.filter((e) => e.type === 'text.delta').map((e) => e.type === 'text.delta' && e.text).join('')).toBe('Paris it is.');
  });

  it('queues the input like enqueue() once the model has emitted text', async () => {
    const slow = textFirst(mockModel(['Rome is lovely.', 'Paris then.']));
    const run = createAgent({ provider: slow.provider }).stream('Plan a trip to Rome.');

    await slow.emitted;
    const steered = run.steer('Actually, make it Paris.');
    slow.release();
    const events = await collect(run);

    expect(steered.applied).toBe('queued');
    expect(await steered.joined).toBe(true);
    expect((await run.result).text).toBe('Paris then.');
    expect(conversation((slow.provider as MockModel).calls[1]?.messages)).toEqual([
      'user:Plan a trip to Rome.',
      'assistant:Rome is lovely.',
      'user:Actually, make it Paris.',
    ]);
    expect(events.find((e) => e.type === 'input.steered')).toMatchObject({ mode: 'queued' });
    expect(events.find((e) => e.type === 'step.done')).toMatchObject({ step: 1, finishReason: 'stop' });
    expect(events.find((e) => e.type === 'input.applied')).toMatchObject({ id: steered.id, step: 2 });
  });

  it('lets a running tool call finish and keeps its result; calls not started yet are not run', async () => {
    const { tool, started, release } = gatedTool();
    const other = vi.fn(async () => 'never');
    const otherTool = defineTool({ name: 'other', description: 'other', input: z.object({}), execute: other });
    const model = mockModel([{ toolCalls: [{ name: 'wait' }, { name: 'other' }] }, 'Redirected.']);
    const run = createAgent({ provider: model, tools: [tool, otherTool], toolConcurrency: 1 }).stream('Start.');

    await started;
    const steered = run.steer('Stop that, do this.');
    release();
    const result = await run.result;

    expect(steered.applied).toBe('queued');
    expect(other).not.toHaveBeenCalled();
    expect(result.text).toBe('Redirected.');
    expect(conversation(model.calls[1]?.messages)).toEqual([
      'user:Start.',
      'assistant:',
      'tool:"waited"',
      'tool:{"error":"ToolNotRunError","toolName":"other","message":"Tool call was cancelled before it ran because the user steered the run to new input","kind":"not-run"}',
      'user:Stop that, do this.',
    ]);
  });

  it('returns applied: false once the run has finished', async () => {
    const run = createAgent({ provider: mockModel(['hi']) }).stream('hello');
    await run.result;

    const steered = run.steer('too late');
    expect(steered.applied).toBe(false);
    expect(await steered.joined).toBe(false);
  });
});

describe('InputQueue.steer()', () => {
  it('redirects a running execute()', async () => {
    const slow = slowTurn('Rome.');
    const model = mockModel([slow.turn, 'Paris.']);
    const inputQueue = new InputQueue();

    const pending = AgentExecutor.execute({
      agent: { id: 'a', name: 'A', prompt: 'p' },
      provider: model,
      input: 'Rome?',
      inputQueue,
    });
    await slow.calling;
    expect(inputQueue.steer('Paris?').applied).toBe('immediate');
    const result = await pending;

    expect(result.text).toBe('Paris.');
    expect(model.calls).toHaveLength(2);
    expect(conversation(result.messages)).toEqual(['user:Rome?', 'user:Paris?', 'assistant:Paris.']);
  });
});

describe('durable steering', () => {
  it('checkpoints the steer input before the new model call, never the discarded turn', async () => {
    const store = memoryStore();
    const slow = slowTurn('DISCARDED');
    const seenByRetry: string[][] = [];
    const model = mockModel([
      slow.turn,
      async () => {
        seenByRetry.push(conversation((await store.checkpoints.load('job-1'))?.messages));
        return { error: new Error('process died') };
      },
      'Paris.',
    ]);
    const agent = createAgent({ provider: model, store });
    const run = agent.stream('Rome?', { sessionId: 'job-1' });

    await slow.calling;
    run.steer('Paris?');
    await expect(run.result).rejects.toThrow('process died');
    slow.release();

    expect(seenByRetry).toEqual([['user:Rome?', 'user:Paris?']]);
    const resumed = await agent.resume('job-1');
    expect(resumed?.text).toBe('Paris.');
    expect(conversation(model.calls[2]?.messages)).toEqual(['user:Rome?', 'user:Paris?']);
    const finished = await store.checkpoints.load('job-1');
    expect(JSON.stringify(finished?.messages)).not.toContain('DISCARDED');
  });
});

describe("agent.session({ turnPolicy: 'steer' })", () => {
  it('steers the running turn with a send() made while it runs', async () => {
    const slow = slowTurn('Rome.');
    const model = mockModel([slow.turn, 'Paris.']);
    const session = createAgent({ provider: model }).session({ turnPolicy: 'steer' });

    const first = session.send('Rome?');
    await slow.calling;
    const second = session.send('Paris?');

    const [a, b] = await Promise.all([first, second]);
    slow.release();
    expect(b).toBe(a);
    expect(model.calls).toHaveLength(2);
    expect(conversation(session.messages)).toEqual(['user:Rome?', 'user:Paris?', 'assistant:Paris.']);
  });
});
