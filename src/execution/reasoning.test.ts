/**
 * LOU-V13: reasoning through a run - `reasoning.*` events in stream order on
 * `ai` v7 and v4 (Anthropic provider, scripted model streams), the
 * `reasoning` option reaching the request (agent-level and per call),
 * `result.reasoning`, the signed thinking kept on the tool-call turn and
 * replayed to the model, and the UI reducer / UI message stream mapping.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as aiV7 from 'ai-v7';
import { MockLanguageModelV4 } from 'ai-v7/test';
import { MockLanguageModelV1 } from 'ai/test';
import { z } from 'zod';
import { AnthropicProvider } from '../providers/AnthropicProvider';
import type { GenerateOptions, GenerateResult, LLMProvider } from '../providers/llm';
import { itOnAiV4 } from '../providers/aiMajor.testkit';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import type { AgentEvent } from './agentEvents';
import { initialAgentUIState, reduceAgentEvents } from '../ui/reducer';
import { toUIMessageStream } from '../server/uiMessageStream';
import { recordLlmResult } from './genAiSpans';
import { SdkAttr } from './semconv';

type V7Part = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;
type V7Options = Parameters<MockLanguageModelV4['doStream']>[0];
type V4Part = Awaited<ReturnType<MockLanguageModelV1['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;
type V4Options = Parameters<MockLanguageModelV1['doStream']>[0];

afterEach(() => {
  vi.restoreAllMocks();
});

function streamOf<P>(parts: P[]): ReadableStream<P> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

const v7Finish = (finish: 'stop' | 'tool-calls', reasoning: number): V7Part => ({
  type: 'finish',
  finishReason: { unified: finish, raw: finish },
  usage: {
    inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: undefined },
    outputTokens: { total: 10, text: 10 - reasoning, reasoning },
  },
});

/** Step 1 thinks (signed) then calls `lookup`; step 2 thinks then answers. Anthropic sends the signature on a delta. */
const V7_STEPS: V7Part[][] = [
  [
    { type: 'stream-start', warnings: [] },
    { type: 'reasoning-start', id: 'r1' },
    { type: 'reasoning-delta', id: 'r1', delta: 'Let me ' },
    { type: 'reasoning-delta', id: 'r1', delta: 'check.' },
    { type: 'reasoning-delta', id: 'r1', delta: '', providerMetadata: { anthropic: { signature: 'sig-1' } } },
    { type: 'reasoning-end', id: 'r1' },
    { type: 'tool-call', toolCallId: 'call_1', toolName: 'lookup', input: '{}' },
    v7Finish('tool-calls', 4),
  ],
  [
    { type: 'stream-start', warnings: [] },
    { type: 'reasoning-start', id: 'r2' },
    { type: 'reasoning-delta', id: 'r2', delta: 'Done.' },
    { type: 'reasoning-end', id: 'r2', providerMetadata: { anthropic: { signature: 'sig-2' } } },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Rome is sunny.' },
    { type: 'text-end', id: 't1' },
    v7Finish('stop', 2),
  ],
];

const V4_STEPS: V4Part[][] = [
  [
    { type: 'reasoning', textDelta: 'Let me ' },
    { type: 'reasoning', textDelta: 'check.' },
    { type: 'reasoning-signature', signature: 'sig-1' },
    { type: 'tool-call', toolCallType: 'function', toolCallId: 'call_1', toolName: 'lookup', args: '{}' },
    { type: 'finish', finishReason: 'tool-calls', usage: { promptTokens: 5, completionTokens: 10 } },
  ],
  [
    { type: 'reasoning', textDelta: 'Done.' },
    { type: 'reasoning-signature', signature: 'sig-2' },
    { type: 'text-delta', textDelta: 'Rome is sunny.' },
    { type: 'finish', finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 10 } },
  ],
];

const lookup = defineTool({ name: 'lookup', description: 'Looks it up', input: z.object({}), execute: () => 'sunny' });

function thinkingAgent(provider: LLMProvider) {
  return createAgent({ provider, model: 'claude-sonnet-4-5', tools: [lookup], reasoning: 'high' });
}

/** The reasoning, text and tool events of a run, in order (deltas with their text). */
function trace(events: AgentEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === 'reasoning.delta' || event.type === 'text.delta') return [`${event.type}:${event.text}`];
    if (event.type === 'reasoning.done') return [`reasoning.done:${event.text}`];
    return /^(reasoning|tool|step)\./.test(event.type) ? [event.type] : [];
  });
}

const EXPECTED_TRACE = [
  'step.start',
  'reasoning.start',
  'reasoning.delta:Let me ',
  'reasoning.delta:check.',
  'reasoning.done:Let me check.',
  'tool.start',
  'tool.done',
  'step.done',
  'step.start',
  'reasoning.start',
  'reasoning.delta:Done.',
  'reasoning.done:Done.',
  'text.delta:Rome is sunny.',
  'step.done',
];

describe('reasoning in a streamed run (LOU-V13)', () => {
  it('ai v7: reports reasoning before text and tools, keeps it out of the text, and replays the signed thinking', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k', maxRetries: 0 });
    const calls: V7Options[] = [];
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        calls.push(options);
        return { stream: streamOf(V7_STEPS[calls.length - 1]!) };
      },
    });
    Object.assign(provider, { ai: aiV7 });
    vi.spyOn(provider as unknown as { createModel: () => Promise<unknown> }, 'createModel').mockResolvedValue(model);

    const run = thinkingAgent(provider).stream('Weather in Rome?');
    const events = await collect(run);
    const result = await run.result;

    expect(trace(events)).toEqual(EXPECTED_TRACE);
    expect(result.text).toBe('Rome is sunny.');
    expect(result.reasoning).toBe('Let me check.\n\nDone.');
    expect(result.usage.reasoningTokens).toBe(6);
    expect(calls[0]!.providerOptions).toEqual({ anthropic: { thinking: { type: 'enabled', budgetTokens: 24576 } } });
    // The tool-call turn keeps its signed block; the final reply carries no reasoning.
    const assistant = result.messages.filter((m) => m.role === 'assistant');
    expect(assistant[0]).toMatchObject({ content: '', reasoning: [{ text: 'Let me check.', signature: 'sig-1' }] });
    expect(assistant[1]).toEqual({ role: 'assistant', content: 'Rome is sunny.' });
    expect(calls[1]!.prompt.find((m) => m.role === 'assistant')).toMatchObject({
      content: [{ type: 'reasoning', text: 'Let me check.', providerOptions: { anthropic: { signature: 'sig-1' } } }, { type: 'tool-call' }],
    });
  });

  itOnAiV4('ai v4: the same events from `reasoning` / `reasoning-signature` parts, and the same replay', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k', maxRetries: 0 });
    const calls: V4Options[] = [];
    const model = new MockLanguageModelV1({
      doStream: async (options) => {
        calls.push(options);
        return { stream: streamOf(V4_STEPS[calls.length - 1]!), rawCall: { rawPrompt: null, rawSettings: {} } };
      },
    });
    vi.spyOn(provider as unknown as { createModel: () => Promise<unknown> }, 'createModel').mockResolvedValue(model);

    const run = thinkingAgent(provider).stream('Weather in Rome?');
    const events = await collect(run);
    const result = await run.result;

    expect(trace(events)).toEqual(EXPECTED_TRACE);
    expect(result.reasoning).toBe('Let me check.\n\nDone.');
    expect(calls[0]!.providerMetadata).toEqual({ anthropic: { thinking: { type: 'enabled', budgetTokens: 24576 } } });
    expect(calls[1]!.prompt.find((m) => m.role === 'assistant')).toMatchObject({
      content: [{ type: 'reasoning', text: 'Let me check.', signature: 'sig-1' }, { type: 'tool-call' }],
    });
  });
});

/** A provider that cannot stream and answers with reasoning; records its requests. */
function thinkingProvider(): LLMProvider & { calls: GenerateOptions[] } {
  const calls: GenerateOptions[] = [];
  const reply: GenerateResult = {
    text: 'Hi.',
    finishReason: 'stop',
    reasoning: [{ text: 'A greeting.' }],
    usage: { promptTokens: 1, completionTokens: 5, totalTokens: 6, reasoningTokens: 3 },
  };
  return {
    name: 'thinker',
    calls,
    generate: async (options) => (calls.push(options), reply),
    stream: async () => {
      throw new Error('not streamed');
    },
    supportsTools: () => true,
    supportsStreaming: () => false,
    getModels: async () => [],
  };
}

describe('the reasoning option and result (LOU-V13)', () => {
  it("sends the agent's reasoning on every call, a call's own instead, and returns the reasoning text", async () => {
    const provider = thinkingProvider();
    const agent = createAgent({ provider, reasoning: 'low' });

    const first = await agent.send('Hello');
    await agent.send('Hello', { reasoning: { effort: 'high', budgetTokens: 4000 } });
    await createAgent({ provider }).send('Hello');

    expect(provider.calls.map((call) => call.reasoning)).toEqual(['low', { effort: 'high', budgetTokens: 4000 }, undefined]);
    expect(first.reasoning).toBe('A greeting.');
    expect(first.text).toBe('Hi.');
    expect(first.messages.at(-1)).toEqual({ role: 'assistant', content: 'Hi.' });
  });

  it('a non-streamed step reports its reasoning as one start/delta/done with the token count, before its text', async () => {
    const events = await collect(createAgent({ provider: thinkingProvider() }).stream('Hello'));
    expect(events.filter((e) => /^(reasoning|text)\./.test(e.type)).map(({ type, ...rest }) => ({ type, ...('text' in rest && { text: rest.text }), ...('tokens' in rest && { tokens: rest.tokens }) }))).toEqual([
      { type: 'reasoning.start' },
      { type: 'reasoning.delta', text: 'A greeting.' },
      { type: 'reasoning.done', text: 'A greeting.', tokens: 3 },
      { type: 'text.delta', text: 'Hi.' },
      { type: 'text.done', text: 'Hi.' },
    ]);
  });

  it('the chat span records the reasoning tokens', () => {
    const span = { id: 's', name: 'chat thinker', attributes: {}, startTime: 0 };
    recordLlmResult(span, { text: 'Hi.', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 5, totalTokens: 6, reasoningTokens: 3 } }, false);
    expect(span.attributes).toMatchObject({ [SdkAttr.USAGE_REASONING_TOKENS]: 3 });
  });

  it('the UI reducer keeps the reasoning on the assistant message; the UI message stream emits reasoning chunks', async () => {
    const events = await collect(createAgent({ provider: thinkingProvider() }).stream('Hello'));
    const state = events.reduce(reduceAgentEvents, reduceAgentEvents(initialAgentUIState, { type: 'ui.send', input: 'Hello' }));
    expect(state.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Hi.', reasoning: 'A greeting.' });

    const chunks = await collect(toUIMessageStream((async function* () { yield* events; })()) as unknown as AsyncIterable<{ type: string; id?: string; delta?: string }>);
    const reasoning = chunks.filter((c) => c.type.startsWith('reasoning') || c.type === 'text-start');
    const id = reasoning[0]!.id;
    expect(reasoning).toEqual([
      { type: 'reasoning-start', id },
      { type: 'reasoning-delta', id, delta: 'A greeting.' },
      { type: 'reasoning-end', id },
      { type: 'text-start', id: 'text-1' },
    ]);
  });
});
