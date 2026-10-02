/**
 * M9: `send()` and `AgentExecutor.execute()` with a listener stream their
 * model calls like `stream()` does - a step's text reaches the listener as
 * several `text.delta` events - without changing what the run returns.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools';
import { LLMProviderRegistry, type LLMProvider } from '../providers/llm';
import { mockModel, type MockModel, type MockTurn } from '../testing';
import { AgentExecutor } from './AgentExecutor';
import type { AgentEvent } from './agentEvents';
import type { IoGuardrail } from './ioGuardrails';

const weather = defineTool({
  name: 'get_weather',
  description: 'Weather for a city',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 21 }),
});

const script = (): MockTurn[] => [
  {
    text: 'Let me check the weather.',
    toolCalls: [{ id: 'call_rome', name: 'get_weather', args: { city: 'Rome' } }],
    usage: { inputTokens: 12, outputTokens: 7 },
  },
  { text: 'It is warm in Rome today.', usage: { inputTokens: 30, outputTokens: 9 } },
];

/** The text of each step's `text.delta` events, step by step. */
function deltasPerStep(events: AgentEvent[]): string[][] {
  const steps: string[][] = [];
  for (const event of events) {
    if (event.type === 'step.start') steps.push([]);
    if (event.type === 'text.delta') steps.at(-1)?.push(event.text);
  }
  return steps;
}

/** `model` with its `stream()` calls counted. */
function counting(model: MockModel, name = model.name): LLMProvider & { streamed: number } {
  const provider = {
    streamed: 0,
    name,
    defaultModel: model.defaultModel,
    generate: (call: Parameters<LLMProvider['generate']>[0]) => model.generate(call),
    stream: (call: Parameters<LLMProvider['stream']>[0]) => {
      provider.streamed += 1;
      return model.stream(call);
    },
    supportsTools: (id: string) => model.supportsTools(id),
    supportsStreaming: (id: string) => model.supportsStreaming(id),
    getModels: () => model.getModels(),
  };
  return provider;
}

describe('send() with a listener streams model calls (M9)', () => {
  it('emits several text.delta per step that add up to the step text, with the usage of a generated run', async () => {
    const heard: AgentEvent[] = [];
    const provider = counting(mockModel(script()));
    const agent = createAgent({ instructions: 'Be brief.', provider, tools: [weather], onEvent: (e) => heard.push(e) });

    const result = await agent.send('Weather in Rome?');

    expect(provider.streamed).toBe(2);
    const steps = deltasPerStep(heard);
    expect(steps).toHaveLength(2);
    expect(steps.every((deltas) => deltas.length > 1)).toBe(true);
    const done = heard.filter((e) => e.type === 'text.done').map((e) => e.text);
    expect(steps.map((deltas) => deltas.join(''))).toEqual(done);
    expect(done).toEqual(['Let me check the weather.', 'It is warm in Rome today.']);
    expect(result.text).toBe('It is warm in Rome today.');

    // The same script without a listener generates each step: same result, same usage (no double counting).
    const plain = counting(mockModel(script()));
    const generated = await createAgent({ instructions: 'Be brief.', provider: plain, tools: [weather] }).send('Weather in Rome?');
    expect(plain.streamed).toBe(0);
    expect(result.usage).toEqual(generated.usage);
    expect(result.toolCalls).toEqual(generated.toolCalls);
    expect(result.steps).toBe(generated.steps);
    expect(heard.filter((e) => e.type === 'step.done').map((e) => e.type === 'step.done' && e.usage?.totalTokens)).toEqual([
      19, 39,
    ]);
  });

  it('streams AgentExecutor.execute({ onAgentEvent }) too, and execute({ streamModelCalls: false }) generates whole steps', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerMany([weather]);
    const agent = { id: 'a', name: 'Agent', prompt: 'p', tools: { get_weather: { tool: 'get_weather' } } };

    const streamedEvents: AgentEvent[] = [];
    const streaming = counting(mockModel(script()));
    await AgentExecutor.execute({ agent, provider: streaming, toolRegistry, input: 'go', onAgentEvent: (e) => streamedEvents.push(e) });
    expect(streaming.streamed).toBe(2);
    expect(deltasPerStep(streamedEvents).map((deltas) => deltas.length > 1)).toEqual([true, true]);

    const wholeEvents: AgentEvent[] = [];
    const whole = counting(mockModel(script()));
    const result = await AgentExecutor.execute({
      agent,
      provider: whole,
      toolRegistry,
      input: 'go',
      onAgentEvent: (e) => wholeEvents.push(e),
      streamModelCalls: false,
    });
    expect(whole.streamed).toBe(0);
    expect(deltasPerStep(wholeEvents)).toEqual([['Let me check the weather.'], ['It is warm in Rome today.']]);
    expect(result.text).toBe('It is warm in Rome today.');
  });

  it('generates whole steps with a provider that cannot stream (one text.delta per step)', async () => {
    const model = mockModel(script());
    const { stream: _stream, ...generateOnly } = counting(model);
    const heard: AgentEvent[] = [];
    const agent = createAgent({ provider: generateOnly as unknown as LLMProvider, tools: [weather], onEvent: (e) => heard.push(e) });

    const result = await agent.send('Weather in Rome?');

    expect(deltasPerStep(heard)).toEqual([['Let me check the weather.'], ['It is warm in Rome today.']]);
    expect(result.text).toBe('It is warm in Rome today.');

    const unsupported: AgentEvent[] = [];
    const notStreaming = Object.assign(counting(mockModel(script())), { supportsStreaming: () => false });
    await createAgent({ provider: notStreaming, tools: [weather], onEvent: (e) => unsupported.push(e) }).send('Weather in Rome?');
    expect(notStreaming.streamed).toBe(0);
    expect(deltasPerStep(unsupported).map((deltas) => deltas.length)).toEqual([1, 1]);
  });

  it('runs output guardrails on the final reply only, as before, while stream() checks every step', async () => {
    const checked: string[] = [];
    const guardrail: IoGuardrail = {
      name: 'no-check',
      check: ({ text }) => {
        checked.push(text);
        return text.includes('check') ? { ok: false, reason: 'mentions check' } : { ok: true };
      },
    };

    const heard: AgentEvent[] = [];
    const listening = createAgent({ provider: mockModel(script()), tools: [weather], guardrails: { output: [guardrail] }, onEvent: (e) => heard.push(e) });
    const sent = await listening.send('Weather in Rome?');
    expect(sent.finishReason).toBe('stop');
    expect(checked).toEqual(['It is warm in Rome today.']);
    expect(deltasPerStep(heard)[0].length).toBeGreaterThan(1);

    checked.length = 0;
    const iterated = createAgent({ provider: mockModel(script()), tools: [weather], guardrails: { output: [guardrail] } });
    const run = iterated.stream('Weather in Rome?');
    for await (const _event of run) void _event;
    expect((await run.result).finishReason).toBe('guardrail');
    expect(checked).toEqual(['Let me check the weather.']);
  });
});

describe('send() with a listener: retry and fallback cover streamed calls (M9)', () => {
  const ENV_VARS = ['LOUSHO_MODEL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_BASE_URL'];
  const apiError = (statusCode: number) =>
    new APICallError({ message: `HTTP ${statusCode}`, url: 'https://api.example.com/v1/chat', requestBodyValues: {}, statusCode, isRetryable: true });

  beforeEach(() => {
    for (const name of ENV_VARS) vi.stubEnv(name, '');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('retries a failed streamed call, then falls back, reporting both to the listener', async () => {
    const primary = counting(mockModel([{ error: apiError(503) }, { error: apiError(503) }]), 'openai');
    const fallback = counting(mockModel(['Hello from the fallback model.'], { defaultModel: 'claude-3-5-haiku-latest' }), 'anthropic');
    const providers: Record<string, LLMProvider> = { openai: primary, anthropic: fallback };
    vi.spyOn(LLMProviderRegistry, 'create').mockImplementation((name) => providers[name]);
    const heard: AgentEvent[] = [];
    const agent = createAgent({
      model: 'openai/gpt-4o-mini',
      fallbackModels: ['anthropic/claude-3-5-haiku-latest'],
      retry: { backoff: { initialMs: 1, jitter: false }, maxRetries: 1 },
      onEvent: (e) => heard.push(e),
    });

    const result = await agent.send('hi');

    expect(result.text).toBe('Hello from the fallback model.');
    expect(primary.streamed).toBe(2);
    expect(fallback.streamed).toBe(1);
    const types = heard.map((e) => e.type);
    expect(types).toContain('provider.retry');
    expect(types).toContain('provider.fallback');
    expect(deltasPerStep(heard)[0].length).toBeGreaterThan(1);
    expect(deltasPerStep(heard)[0].join('')).toBe(result.text);
  });
});
