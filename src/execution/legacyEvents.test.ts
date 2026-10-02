/**
 * LOU-D41: one event system. The deprecated `onEvent` gets ExecutionEvents
 * derived from the run's AgentEvents, in the old order; `onAgentEvent` /
 * `createAgent({ onEvent })` get the AgentEvents `stream()` yields, on
 * `send()` too.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AgentExecutor, type ExecutionEvent } from './AgentExecutor';
import { InMemoryApprovalStore } from './InMemoryApprovalStore';
import { AGENT_EVENT_SCHEMA_VERSION, type AgentEvent, type AgentEventPayload } from './agentEvents';
import { toExecutionEvents } from './legacyEvents';
import { createAgent } from '../createAgent';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools';
import { mockModel, type MockTurn } from '../testing';
import type { AgentConfig } from '../types';

const weather = defineTool({
  name: 'get_weather',
  description: 'Weather for a city',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 21 }),
});

const refund = defineTool({
  name: 'refund',
  description: 'Refund an order',
  input: z.object({ orderId: z.string() }),
  needsApproval: true,
  execute: async () => 'refunded',
});

/** Runs AgentExecutor.execute() with the deprecated `onEvent` and returns what it received. */
async function legacyRun(turns: MockTurn[], tools: DefinedTool[] = []): Promise<{ events: ExecutionEvent[]; error?: unknown }> {
  const toolConfig: AgentConfig['tools'] = {};
  for (const t of tools) toolConfig[t.name] = { tool: t.name };
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerMany(tools);
  const events: ExecutionEvent[] = [];
  try {
    await AgentExecutor.execute({
      agent: { id: 'agent-1', name: 'Agent', prompt: 'p', tools: toolConfig },
      provider: mockModel(turns),
      toolRegistry,
      input: 'go',
      approvalStore: new InMemoryApprovalStore(),
      onEvent: (event) => events.push(event),
    });
    return { events };
  } catch (error) {
    return { events, error };
  }
}

const typesOf = (events: ExecutionEvent[]) => events.map((e) => e.type);

describe('the deprecated onEvent (LOU-D41)', () => {
  it('warns once that it is deprecated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await legacyRun(['Hi.']);
    await legacyRun(['Hi again.']);
    expect(warn.mock.calls.filter(([message]) => String(message).includes('onEvent'))).toHaveLength(1);
    warn.mockRestore();
  });

  it('gets the old events in the old order for a run with text and a tool call', async () => {
    const { events } = await legacyRun([{ toolCalls: [{ name: 'get_weather', args: { city: 'Paris' } }] }, 'Sunny, 21C.'], [weather]);

    expect(typesOf(events)).toEqual(['start', 'tool-call', 'tool-result', 'text-complete', 'finish']);
    expect(events[0]).toMatchObject({ agentId: 'agent-1', agentName: 'Agent' });
    expect(events[1].toolCall).toMatchObject({ id: 'call_1', function: { name: 'get_weather' } });
    expect(events[2].toolResult).toMatchObject({ toolCallId: 'call_1', toolName: 'get_weather', result: { city: 'Paris', tempC: 21 } });
    expect(events[3]).toMatchObject({ text: 'Sunny, 21C.', stepUsage: expect.objectContaining({ step: 2, model: 'mock-model' }) });
    expect(events[4]).toMatchObject({ finishReason: 'stop', usage: expect.objectContaining({ modelCalls: 2 }) });
    expect(events.every((e) => e.timestamp instanceof Date)).toBe(true);
  });

  it('ends a run paused for approval with finish awaiting-approval', async () => {
    const { events } = await legacyRun([{ toolCalls: [{ name: 'refund', args: { orderId: 'A1' } }] }], [refund]);

    expect(typesOf(events)).toEqual(['start', 'tool-call', 'finish']);
    expect(events[2].finishReason).toBe('awaiting-approval');
  });

  it('reports a failed run as error, without finish', async () => {
    const { events, error } = await legacyRun([{ error: new Error('model exploded') }]);

    expect(typesOf(events)).toEqual(['start', 'error']);
    expect(events[1].error).toBe(error);
  });
});

/** An AgentEvent as a run would number it. */
function agentEvent(payload: AgentEventPayload): AgentEvent {
  return { ...payload, runId: 'r', seq: 0, timestamp: new Date(0).toISOString(), v: AGENT_EVENT_SCHEMA_VERSION } as AgentEvent;
}

describe('toExecutionEvents()', () => {
  it('derives each old event from the AgentEvent alone', () => {
    const [toolCall] = toExecutionEvents(agentEvent({ type: 'tool.start', toolCallId: 'c1', toolName: 't', args: { a: 1 } }));
    expect(toolCall).toMatchObject({ type: 'tool-call', toolCall: { id: 'c1', type: 'function', function: { name: 't', arguments: '{"a":1}' } } });

    const [done] = toExecutionEvents(agentEvent({ type: 'tool.done', toolCallId: 'c1', toolName: 't', result: 1, durationMs: 1, replacedByHook: 'h' }));
    expect(done.toolResult).toEqual({ toolCallId: 'c1', toolName: 't', result: 1, replacedByHook: 'h' });

    const [failed] = toExecutionEvents(agentEvent({ type: 'tool.error', toolCallId: 'c1', toolName: 't', error: { name: 'E', message: 'bad' }, durationMs: 1 }));
    expect(failed.toolResult).toMatchObject({ result: { error: 'E' }, error: 'bad' });

    const [error] = toExecutionEvents(agentEvent({ type: 'error', error: { name: 'TypeError', message: 'boom' } }));
    expect(error.error).toBeInstanceOf(Error);
    expect(error.error).toMatchObject({ name: 'TypeError', message: 'boom' });
  });

  it('maps run.done to abort + finish, finish, or nothing for a failed run', () => {
    const reason = new Error('stop');
    const aborted = toExecutionEvents(agentEvent({ type: 'run.done', finishReason: 'aborted', text: '' }), { abortReason: reason });
    expect(typesOf(aborted)).toEqual(['abort', 'finish']);
    expect(aborted[0].abortReason).toBe(reason);
    expect(typesOf(toExecutionEvents(agentEvent({ type: 'run.done', finishReason: 'stop', text: 'ok' })))).toEqual(['finish']);
    expect(toExecutionEvents(agentEvent({ type: 'run.done', finishReason: 'error', text: '' }))).toEqual([]);
    expect(toExecutionEvents(agentEvent({ type: 'step.start', step: 1 }))).toEqual([]);
  });
});

/** Drops what differs between two runs of the same script: ids, times and durations. */
function comparable(events: AgentEvent[]): unknown[] {
  return events.map((event) => ({ ...event, runId: '', timestamp: '', ...('durationMs' in event && { durationMs: 0 }) }));
}

describe('createAgent({ onEvent }) (LOU-D41)', () => {
  const script = (): MockTurn[] => [{ text: 'Checking.', toolCalls: [{ id: 'call_rome', name: 'get_weather', args: { city: 'Rome' } }] }, 'Warm.'];

  it('gets the same AgentEvents from send() as stream() yields', async () => {
    const heard: AgentEvent[] = [];
    // M9: send() with a listener streams its model calls, so its text.delta events match a stream's chunk for chunk.
    const provider = mockModel([...script(), ...script()]);
    const agent = createAgent({ instructions: 'Be brief.', provider, tools: [weather], onEvent: (e) => heard.push(e) });
    await agent.send('go');
    const sent = heard.splice(0);

    const run = agent.stream('go');
    const yielded: AgentEvent[] = [];
    for await (const event of run) yielded.push(event);

    expect(heard).toEqual(yielded);
    expect(comparable(sent)).toEqual(comparable(yielded));
    expect(sent.map((e) => e.type)).toContain('tool.done');
    expect(sent.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'stop', text: 'Warm.' });
  });

  it('reports a failed send() as error then run.done', async () => {
    const events: AgentEvent[] = [];
    const agent = createAgent({ instructions: 'x', provider: mockModel([{ error: new Error('model exploded') }]), onEvent: (e) => events.push(e) });

    await expect(agent.send('hi')).rejects.toThrow();
    expect(events.map((e) => e.type)).toEqual(['run.start', 'step.start', 'error', 'step.done', 'run.done']);
    expect(events.at(-1)).toMatchObject({ finishReason: 'error' });
  });
});
