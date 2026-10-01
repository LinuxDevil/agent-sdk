/**
 * LOU-V2: `agent.stream()` / `AgentExecutor.stream()` - the typed, versioned
 * event stream over the ordinary AgentExecutor loop.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AgentExecutor, ExecutionEvent } from './AgentExecutor';
import type { ApprovalStore } from './ApprovalGate';
import type { CheckpointStore } from './checkpoint';
import { AGENT_EVENT_SCHEMA_VERSION, AgentEvent, AgentEventOf, AgentEventType, isAgentEvent, isStepEvent, isTextEvent, isToolEvent } from './agentEvents';
import type { AgentRun } from './agentRun';
import { createAgent } from '../createAgent';
import { defineTool, DefinedTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools';
import { mockModel, MockModel, MockTurn } from '../testing';
import { AgentConfig, AgentType } from '../types';
import type { LLMProvider, StreamChunk } from '../providers';

/** Reads every event, then checks the invariants every run must satisfy. */
async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  expectWellFormed(events, run.runId);
  return events;
}

function expectWellFormed(events: AgentEvent[], runId: string): void {
  events.forEach((event, index) => {
    expect(event.seq).toBe(index);
    expect(event.runId).toBe(runId);
    expect(event.v).toBe(AGENT_EVENT_SCHEMA_VERSION);
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    expect(JSON.parse(JSON.stringify(event))).toStrictEqual(event);
    expect(isAgentEvent(event)).toBe(true);
  });
  expect(events[0].type).toBe('run.start');
  expect(events.filter((e) => e.type === 'run.done')).toHaveLength(1);
  expect(events.at(-1)?.type).toBe('run.done');
  const starts = events.filter((e) => e.type === 'step.start').map((e) => e.step);
  const dones = events.filter((e) => e.type === 'step.done').map((e) => e.step);
  expect(dones).toEqual(starts);
}

const typesOf = (events: AgentEvent[]): AgentEventType[] => events.map((e) => e.type);

function only<T extends AgentEventType>(events: AgentEvent[], type: T): AgentEventOf<T>[] {
  return events.filter((e): e is AgentEventOf<T> => e.type === type);
}

function agentWith(provider: LLMProvider, tools: DefinedTool[] = []) {
  return createAgent({ instructions: 'Be brief.', provider, tools });
}

/** AgentExecutor.stream() options for an agent with `tools` (for options createAgent does not expose). */
function executorOptions(provider: LLMProvider, tools: DefinedTool[]) {
  const toolConfig: AgentConfig['tools'] = {};
  for (const t of tools) toolConfig[t.name] = { tool: t.name };
  const agent: AgentConfig = { id: 'agent-1', name: 'Agent', agentType: AgentType.SmartAssistant, prompt: 'p', tools: toolConfig };
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerMany(tools);
  return { agent, provider, toolRegistry, input: 'go' };
}

const weather = defineTool({
  name: 'get_weather',
  description: 'Weather for a city',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 21 }),
});

/** Wraps a mockModel so its stream pauses after the first chunk until `release()`. */
function pausingAfterFirstChunk(model: MockModel): { provider: MockModel; firstChunk: Promise<void>; release: () => void } {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const firstChunk = new Promise<void>((resolve) => (reached = resolve));
  const stream = model.stream.bind(model);
  model.stream = async (options) => {
    const streamed = await stream(options);
    const source = streamed.fullStream;
    const fullStream = (async function* (): AsyncGenerator<StreamChunk> {
      let first = true;
      for await (const chunk of source) {
        yield chunk;
        if (first) {
          first = false;
          reached();
          await gate;
        }
      }
    })();
    return { ...streamed, fullStream };
  };
  return { provider: model, firstChunk, release };
}

describe('agent.stream()', () => {
  it('streams a text-only run as word chunks, bracketed by run and step events', async () => {
    const run = agentWith(mockModel([{ text: 'Hello there world', usage: { inputTokens: 3, outputTokens: 2 } }])).stream('hi');
    const events = await collect(run);

    expect(typesOf(events)).toEqual([
      'run.start',
      'step.start',
      'text.delta',
      'text.delta',
      'text.delta',
      'text.done',
      'step.done',
      'run.done',
    ]);
    expect(only(events, 'text.delta').map((e) => e.text)).toEqual(['Hello ', 'there ', 'world']);
    expect(only(events, 'text.done')[0].text).toBe('Hello there world');
    const usage = { promptTokens: 3, completionTokens: 2, totalTokens: 5 };
    expect(only(events, 'step.done')[0]).toMatchObject({ step: 1, finishReason: 'stop', usage });
    expect(only(events, 'run.done')[0]).toMatchObject({ finishReason: 'stop', text: 'Hello there world', usage });
    expect(only(events, 'run.start')[0].agentName).toBe('agent');

    const result = await run.result;
    expect(result.text).toBe('Hello there world');
    expect(result.messages.at(-1)).toEqual({ role: 'assistant', content: 'Hello there world' });
  });

  it('reports a tool run step by step and resolves the same result send() returns', async () => {
    const turns: MockTurn[] = [{ toolCalls: [{ name: 'get_weather', args: { city: 'Paris' } }] }, 'Sunny, 21C.'];
    const run = agentWith(mockModel(turns), [weather]).stream('Weather in Paris?');
    const events = await collect(run);

    expect(typesOf(events)).toEqual([
      'run.start',
      'step.start',
      'tool.start',
      'tool.done',
      'step.done',
      'step.start',
      'text.delta',
      'text.delta',
      'text.done',
      'step.done',
      'run.done',
    ]);
    expect(only(events, 'tool.start')[0]).toMatchObject({ toolCallId: 'call_1', toolName: 'get_weather', args: { city: 'Paris' } });
    const done = only(events, 'tool.done')[0];
    expect(done).toMatchObject({ toolCallId: 'call_1', toolName: 'get_weather', result: { city: 'Paris', tempC: 21 } });
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
    expect(only(events, 'step.done').map((e) => [e.step, e.finishReason])).toEqual([
      [1, 'tool_calls'],
      [2, 'stop'],
    ]);

    const sent = await agentWith(mockModel(turns), [weather]).send('Weather in Paris?');
    const streamed = await run.result;
    expect(streamed).toEqual(sent);
  });

  it('starts parallel tool calls in call order and reports them done in completion order', async () => {
    let fastDone!: () => void;
    const fastFinished = new Promise<void>((resolve) => (fastDone = resolve));
    const slow = defineTool({
      name: 'slow',
      description: 'slow',
      input: z.object({}),
      execute: async () => {
        await fastFinished;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'slow done';
      },
    });
    const fast = defineTool({
      name: 'fast',
      description: 'fast',
      input: z.object({}),
      execute: async () => {
        fastDone();
        return 'fast done';
      },
    });
    const model = mockModel([{ toolCalls: [{ name: 'slow' }, { name: 'fast' }] }, 'ok']);
    const events = await collect(agentWith(model, [slow, fast]).stream('go'));

    const toolEvents = events.filter(isToolEvent).map((e) => `${e.type}:${e.toolName}`);
    expect(toolEvents).toEqual(['tool.start:slow', 'tool.start:fast', 'tool.done:fast', 'tool.done:slow']);
  });

  it('reports a failing tool as tool.error with a JSON-safe error and carries on', async () => {
    class WeatherDown extends Error {
      override name = 'WeatherDown';
    }
    const broken = defineTool({
      name: 'get_weather',
      description: 'Weather',
      input: z.object({ city: z.string() }),
      execute: async () => {
        throw new WeatherDown('service unavailable');
      },
    });
    const model = mockModel([{ toolCalls: [{ name: 'get_weather', args: { city: 'Oslo' } }] }, 'Sorry, no data.']);
    const run = agentWith(model, [broken]).stream('Weather in Oslo?');
    const events = await collect(run);

    const [failure] = only(events, 'tool.error');
    expect(failure).toMatchObject({
      toolCallId: 'call_1',
      toolName: 'get_weather',
      error: { name: 'WeatherDown', message: 'service unavailable' },
    });
    expect(failure.durationMs).toBeGreaterThanOrEqual(0);
    expect(only(events, 'tool.done')).toHaveLength(0);
    expect((await run.result).text).toBe('Sorry, no data.');
  });

  it('ends with approval.requested and run.done awaiting-approval when a tool needs approval', async () => {
    const refund = defineTool({
      name: 'refund',
      description: 'Refund an order',
      input: z.object({ orderId: z.string() }),
      needsApproval: true,
      execute: async () => 'refunded',
    });
    const saved: string[] = [];
    const approvalStore: ApprovalStore = {
      save: async (pending) => void saved.push(pending.id),
      resolve: async () => null,
    };
    const model = mockModel([{ toolCalls: [{ name: 'refund', args: { orderId: 'A1' } }] }]);
    const run = AgentExecutor.stream({ ...executorOptions(model, [refund]), approvalStore });
    const events = await collect(run);

    expect(typesOf(events)).toEqual(['run.start', 'step.start', 'tool.start', 'approval.requested', 'step.done', 'run.done']);
    const result = await run.result;
    expect(only(events, 'approval.requested')[0]).toMatchObject({
      approvalId: result.approvalId,
      toolCallId: 'call_1',
      toolName: 'refund',
      args: { orderId: 'A1' },
    });
    expect(saved).toEqual([result.approvalId]);
    expect(only(events, 'step.done')[0].finishReason).toBe('awaiting-approval');
    expect(only(events, 'run.done')[0].finishReason).toBe('awaiting-approval');
  });

  it('stops mid-stream when the signal is aborted, ending with run.done aborted', async () => {
    const { provider, firstChunk, release } = pausingAfterFirstChunk(mockModel(['one two three four']));
    const controller = new AbortController();
    const run = agentWith(provider).stream('count', { signal: controller.signal });
    void firstChunk.then(() => {
      controller.abort();
      release();
    });
    const events = await collect(run);

    expect(typesOf(events)).toEqual(['run.start', 'step.start', 'text.delta', 'step.done', 'run.done']);
    expect(only(events, 'step.done')[0].finishReason).toBe('aborted');
    expect(only(events, 'run.done')[0].finishReason).toBe('aborted');
    expect((await run.result).finishReason).toBe('aborted');
  });

  it('returns at once with run.start and run.done for an already-aborted signal', async () => {
    const model = mockModel(['never']);
    const run = agentWith(model).stream('hi', { signal: AbortSignal.abort() });
    expect(typesOf(await collect(run))).toEqual(['run.start', 'run.done']);
    expect((await run.result).finishReason).toBe('aborted');
    expect(model.calls).toHaveLength(0);
  });

  it('aborts the run when the consumer breaks out of the loop early', async () => {
    let toolSignal: AbortSignal | undefined;
    const hang = defineTool({
      name: 'hang',
      description: 'Waits until cancelled',
      input: z.object({}),
      execute: (_args, { abortSignal }) => {
        toolSignal = abortSignal;
        return new Promise((_resolve, reject) => {
          if (abortSignal?.aborted) reject(abortSignal.reason);
          abortSignal?.addEventListener('abort', () => reject(abortSignal.reason));
        });
      },
    });
    const run = agentWith(mockModel([{ toolCalls: [{ name: 'hang' }] }, 'unused']), [hang]).stream('go');

    const seen: AgentEventType[] = [];
    for await (const event of run) {
      seen.push(event.type);
      if (event.type === 'tool.start') break;
    }

    const result = await run.result;
    expect(seen).toEqual(['run.start', 'step.start', 'tool.start']);
    expect(result.finishReason).toBe('aborted');
    expect(toolSignal?.aborted).toBe(true);
  });

  it('drives the run to completion when only result is awaited, keeping every event for a later read', async () => {
    const onEvent = vi.fn<(event: ExecutionEvent) => void>();
    const run = AgentExecutor.stream({ ...executorOptions(mockModel(['Done here']), []), onEvent });

    const result = await run.result;
    expect(result.text).toBe('Done here');
    expect(onEvent.mock.calls.map(([e]) => e.type)).toEqual(['start', 'text-complete', 'finish']);

    const events = await collect(run);
    expect(only(events, 'text.delta').map((e) => e.text)).toEqual(['Done ', 'here']);
  });

  it('falls back to generate() with a single text.delta when the provider has no stream()', async () => {
    const model = mockModel(['Hi there']);
    const generateOnly = Object.assign(Object.create(model) as MockModel, { stream: undefined });
    const events = await collect(agentWith(generateOnly).stream('hi'));

    expect(typesOf(events)).toEqual(['run.start', 'step.start', 'text.delta', 'text.done', 'step.done', 'run.done']);
    expect(only(events, 'text.delta')[0].text).toBe('Hi there');
    expect(model.calls).toHaveLength(1);
  });

  it('falls back to generate() when the provider does not support streaming the model', async () => {
    const model = mockModel(['Hi there']);
    model.supportsStreaming = () => false;
    const stream = vi.spyOn(model, 'stream');
    const events = await collect(agentWith(model).stream('hi'));

    expect(only(events, 'text.delta').map((e) => e.text)).toEqual(['Hi there']);
    expect(stream).not.toHaveBeenCalled();
  });

  it('reports a provider failure as error then run.done error, and result rejects', async () => {
    const run = agentWith(mockModel([{ error: new Error('model exploded') }])).stream('hi');
    const events = await collect(run);

    expect(typesOf(events)).toEqual(['run.start', 'step.start', 'error', 'step.done', 'run.done']);
    expect(only(events, 'error')[0].error.message).toContain('model exploded');
    expect(only(events, 'step.done')[0].finishReason).toBe('error');
    expect(only(events, 'run.done')[0]).toStrictEqual(expect.objectContaining({ finishReason: 'error', text: '' }));
    expect(only(events, 'run.done')[0]).not.toHaveProperty('usage');
    await expect(run.result).rejects.toThrow(/model exploded/);
  });

  it('emits an error event for a failure outside any step (and never an unhandled rejection)', async () => {
    const checkpointStore: CheckpointStore = {
      load: async () => {
        throw new Error('checkpoint store offline');
      },
      save: async () => undefined,
      delete: async () => undefined,
    };
    const run = AgentExecutor.stream({ ...executorOptions(mockModel([]), []), sessionId: 's1', checkpointStore });
    const events = await collect(run);

    expect(typesOf(events)).toEqual(['run.start', 'error', 'run.done']);
    expect(only(events, 'error')[0].error).toEqual({ name: 'Error', message: 'checkpoint store offline' });
  });

  it('streams model text that comes with tool calls before the tools run', async () => {
    const model = mockModel([{ text: 'Checking.', toolCalls: [{ name: 'get_weather', args: { city: 'Rome' } }] }, 'Warm.']);
    const events = await collect(agentWith(model, [weather]).stream('Rome?'));
    expect(typesOf(events).slice(0, 5)).toEqual(['run.start', 'step.start', 'text.delta', 'text.done', 'tool.start']);
  });

  it('fails the step on an error chunk from the provider stream', async () => {
    const model = mockModel(['never shown']);
    model.stream = async () => ({
      fullStream: (async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'error', error: new Error('stream broke') };
      })(),
      textStream: (async function* () {})(),
      text: Promise.resolve(''),
      usage: Promise.reject(new Error('stream broke')),
      finishReason: Promise.reject(new Error('stream broke')),
      toolCalls: Promise.reject(new Error('stream broke')),
    });
    const run = agentWith(model).stream('hi');
    const events = await collect(run);

    expect(only(events, 'error')[0].error.message).toContain('stream broke');
    await expect(run.result).rejects.toThrow(/stream broke/);
  });

  it('can be iterated only once', async () => {
    const run = agentWith(mockModel(['x'])).stream('hi');
    await collect(run);
    await expect(collect(run)).rejects.toThrow(/only be iterated once/);
  });

  it('throws synchronously on invalid options, naming stream()', () => {
    const { agent } = executorOptions(mockModel([]), []);
    expect(() => AgentExecutor.stream({ agent, input: 'x' } as never)).toThrow(/AgentExecutor.stream: 'provider' is required/);
  });

  it('family type guards narrow by prefix', async () => {
    const events = await collect(agentWith(mockModel(['a b'])).stream('hi'));
    expect(events.filter(isTextEvent).map((e) => e.type)).toEqual(['text.delta', 'text.delta', 'text.done']);
    expect(events.filter(isStepEvent).map((e) => e.step)).toEqual([1, 1]);
    expect(isAgentEvent({ type: 'text.delta', v: 2, seq: 0 })).toBe(false);
    expect(isAgentEvent('text.delta')).toBe(false);
  });
});
