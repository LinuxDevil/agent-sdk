/**
 * AiSdkProvider (shared 'ai'-SDK adapter base) Tests
 *
 * Mocks the 'ai' SDK's generateText/streamText (no live API key required)
 * and drives the shared generate()/stream() logic through concrete
 * providers: the call settings handed to the 'ai' SDK, finish-reason
 * mapping, tool conversion, and message conversion (shared by OpenRouter).
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

const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };

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
    expect(settings).toMatchObject({ temperature: 0.2, maxTokens: 10, seed: 7, maxSteps: 1 });
    // An empty tool list is sent as "no tools"
    expect(settings.tools).toBeUndefined();
    expect(settings.messages).toEqual([{ role: 'user', content: 'hi' }]);
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
    expect(await tools.search.execute()).toBeNull();
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
      toolCalls: Promise.resolve([{ toolCallId: 'c1', toolName: 't', args: { x: 1 } }]),
    });
    const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k' });

    const result = await provider.stream({ model: 'gpt-4', messages: [] });
    const deltas: string[] = [];
    for await (const delta of result.textStream) deltas.push(delta);

    expect(deltas).toEqual(['a', 'b']);
    expect(await result.usage).toEqual(usage);
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
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'search', result: 'r' }] },
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
          { type: 'tool-call', toolCallId: 'c1', toolName: 'search', args: { q: 'x' } },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'search', result: 'r' }] },
    ]);
  });
});
