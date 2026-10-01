/**
 * LOU-V2: AgentExecutor.stream() through a real 'ai'-SDK-backed provider.
 * Its stream reports tool calls only on the `toolCalls` promise (not as
 * chunks) and uses the SDK's `'tool-calls'` finish reason spelling.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

const streamTextMock = vi.fn();
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return { ...actual, streamText: (...args: unknown[]) => streamTextMock(...args) };
});

import { createAgent } from '../createAgent';
import { OpenAIProvider } from '../providers/OpenAIProvider';
import { defineTool } from '../tools/defineTool';
import type { AgentEvent } from './agentEvents';

const usage = { promptTokens: 4, completionTokens: 2, totalTokens: 6 };

function sdkStream(deltas: string[], finishReason: string, toolCalls: unknown[] = []) {
  return {
    textStream: (async function* () {
      yield* deltas;
    })(),
    text: Promise.resolve(deltas.join('')),
    usage: Promise.resolve(usage),
    finishReason: Promise.resolve(finishReason),
    toolCalls: Promise.resolve(toolCalls),
  };
}

describe('AgentExecutor.stream() with an ai-SDK provider', () => {
  it('assembles tool calls from the stream result and streams the reply text', async () => {
    streamTextMock
      .mockReturnValueOnce(sdkStream([], 'tool-calls', [{ toolCallId: 'c1', toolName: 'lookup', args: { q: 'x' } }]))
      .mockReturnValueOnce(sdkStream(['Found ', 'it.'], 'stop'));
    const lookup = defineTool({
      name: 'lookup',
      description: 'Look something up',
      input: z.object({ q: z.string() }),
      execute: async ({ q }) => `result for ${q}`,
    });
    const agent = createAgent({ provider: new OpenAIProvider({ name: 'openai', apiKey: 'k' }), tools: [lookup] });

    const run = agent.stream('find x');
    const events: AgentEvent[] = [];
    for await (const event of run) events.push(event);

    expect(events.map((e) => e.type)).toEqual([
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
    expect(events.find((e) => e.type === 'tool.done')).toMatchObject({ toolCallId: 'c1', result: 'result for x' });
    expect(events.find((e) => e.type === 'step.done')).toMatchObject({ finishReason: 'tool_calls', usage });
    const result = await run.result;
    expect(result.text).toBe('Found it.');
    expect(result.usage).toMatchObject({ promptTokens: 8, completionTokens: 4, totalTokens: 12 });
  });
});
