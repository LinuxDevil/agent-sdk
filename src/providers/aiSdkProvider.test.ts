/**
 * AiSdkProvider (shared 'ai'-SDK adapter base) Tests
 *
 * Mocks the 'ai' SDK's generateText/streamText (no live API key required)
 * and drives the shared generate()/stream() logic through concrete
 * providers: the call settings handed to the 'ai' SDK, finish-reason
 * mapping, tool conversion, and message conversion (shared by OpenRouter).
 * Runs on every `ai` major (LOU-D28f): where the call or result shape differs
 * (v4 `maxTokens`, `args`, `result`; v5+ `maxOutputTokens`, `input`, `output`)
 * the test asserts the installed major's shape, built with aiShapes.testkit.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const generateTextMock = vi.fn();
const streamTextMock = vi.fn();

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: (...args: unknown[]) => generateTextMock(...args),
    streamText: (...args: unknown[]) => streamTextMock(...args),
  };
});

import { OpenAIProvider } from './OpenAIProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import { installedAiMajor } from './aiMajor.testkit';
import { mockToolCall, mockUsage, toolCallPart, toolResultPart } from './aiShapes.testkit';

const isV4 = installedAiMajor === 4;
/** What the mocked `ai` calls report (the installed major's shape) and what the provider turns it into. */
const usage = mockUsage();
const providerUsage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };

function textResult(finishReason: string) {
  return { text: 'ok', finishReason, usage, toolCalls: undefined };
}

describe('AiSdkProvider', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    streamTextMock.mockReset();
  });

  it('passes call settings through and falls back to the config default model', async () => {
    generateTextMock.mockResolvedValue(textResult('stop'));
    const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k', defaultModel: 'gpt-4o' });

    await provider.generate({
      model: '',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      maxTokens: 10,
      seed: 7,
      tools: [],
    });

    const settings = generateTextMock.mock.calls[0][0];
    expect(settings.model.modelId).toBe('gpt-4o');
    expect(settings).toMatchObject({ temperature: 0.2, seed: 7 });
    if (isV4) {
      expect(settings).toMatchObject({ maxTokens: 10, maxSteps: 1 });
    } else {
      expect(settings).toMatchObject({ maxOutputTokens: 10, allowSystemInMessages: true });
      expect(settings.stopWhen).toBeDefined();
    }
    // An empty tool list is sent as "no tools"
    expect(settings.tools).toBeUndefined();
    expect(settings.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('LOU-V7.2: passes config.maxRetries (default 2) to the ai SDK calls', async () => {
    generateTextMock.mockResolvedValue(textResult('stop'));
    streamTextMock.mockResolvedValue({ textStream: (async function* () {})(), text: '', usage, finishReason: 'stop', toolCalls: [] });
    const call = { model: '', messages: [] };

    await new OpenAIProvider({ apiKey: 'k' }).generate(call);
    await new OpenAIProvider({ apiKey: 'k', maxRetries: 0 }).generate(call);
    await new OpenAIProvider({ apiKey: 'k', maxRetries: 0 }).stream(call);

    expect(generateTextMock.mock.calls.map(([settings]) => settings.maxRetries)).toEqual([2, 0]);
    expect(streamTextMock.mock.calls[0][0].maxRetries).toBe(0);
  });

  it('LOU-V5: reports usage as-is, reads cache/reasoning tokens from provider metadata, and no usage when counts are NaN', async () => {
    const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k' });

    // v4 reports cache tokens in the provider metadata, v5+ in the usage details.
    generateTextMock.mockResolvedValue(
      isV4
        ? { ...textResult('stop'), providerMetadata: { openai: { cachedPromptTokens: 1, reasoningTokens: 'n/a' } } }
        : { ...textResult('stop'), usage: { ...usage, inputTokenDetails: { cacheReadTokens: 1 } } }
    );
    expect((await provider.generate({ model: '', messages: [] })).usage).toEqual({
      ...providerUsage,
      cachedInputTokens: 1,
    });

    const nan = Number.NaN;
    generateTextMock.mockResolvedValue({
      ...textResult('stop'),
      usage: isV4 ? { promptTokens: nan, completionTokens: nan, totalTokens: nan } : { inputTokens: nan, outputTokens: nan, totalTokens: nan },
    });
    expect((await provider.generate({ model: '', messages: [] })).usage).toBeUndefined();
  });

  it('falls back to the provider default model when neither call nor config names one', async () => {
    generateTextMock.mockResolvedValue(textResult('stop'));
    const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k' });

    await provider.generate({ model: '', messages: [] });

    expect(generateTextMock.mock.calls[0][0].model.modelId).toBe('gpt-4');
  });

  it('LOU-V1: forwards GenerateOptions.signal to the ai SDK as abortSignal', async () => {
    generateTextMock.mockResolvedValue(textResult('stop'));
    streamTextMock.mockResolvedValue({
      textStream: (async function* () {})(),
      text: Promise.resolve(''),
      usage: Promise.resolve(usage),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    });
    const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k' });
    const { signal } = new AbortController();

    await provider.generate({ messages: [], signal });
    await provider.stream({ messages: [], signal });

    expect(generateTextMock.mock.calls[0][0].abortSignal).toBe(signal);
    expect(streamTextMock.mock.calls[0][0].abortSignal).toBe(signal);
  });

  it('LOU-V4: maps responseFormat to a JSON-mode experimental_output that leaves prompt and text alone', async () => {
    generateTextMock.mockResolvedValue(textResult('stop'));
    const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k' });
    const schema = { type: 'object', properties: { a: { type: 'number' } } };

    await provider.generate({ messages: [] });
    await provider.generate({ messages: [], responseFormat: { type: 'json', schema } });

    const key = isV4 ? 'experimental_output' : 'output';
    expect(generateTextMock.mock.calls[0][0][key]).toBeUndefined();
    const output = generateTextMock.mock.calls[1][0][key];
    if (isV4) {
      expect(output.type).toBe('object');
      expect(output.responseFormat({ model: { supportsStructuredOutputs: true } })).toEqual({ type: 'json', schema });
      expect(output.responseFormat({ model: { supportsStructuredOutputs: false } })).toEqual({ type: 'json', schema: undefined });
      expect(output.injectIntoSystemPrompt({ system: undefined, model: {} })).toBeUndefined();
      expect(output.parsePartial({ text: '{"a"' })).toEqual({ partial: '{"a"' });
      expect(output.parseOutput({ text: 'raw' }, {})).toBe('raw');
    } else {
      expect(await output.responseFormat).toEqual({ type: 'json', schema });
      expect(await output.parsePartialOutput({ text: '{"a"' })).toEqual({ partial: '{"a"' });
      expect(await output.parseCompleteOutput({ text: 'raw' })).toBe('raw');
    }
  });

  it.each([
    ['stop', 'stop'],
    ['length', 'length'],
    ['tool-calls', 'tool_calls'],
    ['content-filter', 'content_filter'],
    ['other', 'error'],
    ['toString', 'error'],
  ])('maps finish reason %s to %s', async (sdkReason, expected) => {
    generateTextMock.mockResolvedValue(textResult(sdkReason));
    const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k' });

    const result = await provider.generate({ model: 'gpt-4', messages: [] });

    expect(result.finishReason).toBe(expected);
    expect(result.toolCalls).toBeUndefined();
  });

  it('converts tool definitions to named ai SDK tools', async () => {
    generateTextMock.mockResolvedValue(textResult('stop'));
    const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k' });

    await provider.generate({
      model: 'gpt-4',
      messages: [],
      tools: [{ type: 'function', function: { name: 'search', description: 'Search', parameters: {} } }],
    });

    const { tools } = generateTextMock.mock.calls[0][0];
    expect(Object.keys(tools)).toEqual(['search']);
    expect(tools.search.description).toBe('Search');
    if (isV4) {
      expect(await tools.search.execute()).toBeNull();
    } else {
      // v5+: an `inputSchema` and no `execute`, so the SDK returns the call and AgentExecutor runs it.
      expect(tools.search.inputSchema).toBeDefined();
      expect(tools.search.execute).toBeUndefined();
    }
  });

  it('stream() exposes textStream and resolved final values', async () => {
    async function* textStream() {
      yield 'a';
      yield 'b';
    }
    streamTextMock.mockReturnValue({
      textStream: textStream(),
      text: Promise.resolve('ab'),
      usage: Promise.resolve(usage),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([mockToolCall('c1', 't', { x: 1 })]),
    });
    const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k' });

    const result = await provider.stream({ model: 'gpt-4', messages: [] });
    const deltas: string[] = [];
    for await (const delta of result.textStream) deltas.push(delta);

    expect(deltas).toEqual(['a', 'b']);
    expect(await result.usage).toEqual(providerUsage);
    expect(await result.finishReason).toBe('stop');
    expect(await result.toolCalls).toEqual([
      { id: 'c1', type: 'function', function: { name: 't', arguments: '{"x":1}' } },
    ]);
  });

  it('uses the default converter for tool results (name -> toolName)', async () => {
    generateTextMock.mockResolvedValue(textResult('stop'));
    const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k' });

    await provider.generate({
      model: 'gpt-4',
      messages: [{ role: 'tool', content: 'r', name: 'search', toolCallId: 'c1' }],
    });

    expect(generateTextMock.mock.calls[0][0].messages).toEqual([
      { role: 'tool', content: [toolResultPart('c1', 'search', 'r')] },
    ]);
  });

  it('converts OpenRouter tool-call turns with the shared converter', async () => {
    generateTextMock.mockResolvedValue(textResult('stop'));
    const provider = new OpenRouterProvider({ name: 'openrouter', apiKey: 'k' });

    await provider.generate({
      model: 'openai/gpt-4o',
      messages: [
        { role: 'user', content: '' },
        {
          role: 'assistant',
          content: 'calling',
          toolCalls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
        },
        { role: 'tool', content: 'r', toolName: 'search', toolCallId: 'c1' },
      ],
    });

    expect(generateTextMock.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: '' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          toolCallPart('c1', 'search', { q: 'x' }),
        ],
      },
      { role: 'tool', content: [toolResultPart('c1', 'search', 'r')] },
    ]);
  });
});
