/**
 * Anthropic Provider Tests
 *
 * Mirrors OpenAIProvider.test.ts's non-generate tests (constructor,
 * supportsTools, supportsStreaming, getModels), and additionally mocks the
 * 'ai' SDK's generateText/streamText (no live API key required) to verify
 * generate()/stream() return the same GenerateResult/StreamResult/
 * StreamChunk shapes OpenAIProvider produces for an equivalent scenario.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GenerateOptions } from './llm';

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

import { AnthropicProvider, AnthropicProviderConfig } from './AnthropicProvider';
import { LLMProviderRegistry } from './llm';

// index.ts registers 'anthropic' as a side effect of being imported, but
// index.ts also unconditionally imports OpenAIProvider.ts/OllamaProvider.ts,
// whose top-level imports of the (here uninstalled) '@ai-sdk/openai' and
// 'ollama-ai-provider' optional peer deps fail Vite's static module graph
// resolution during test collection - the same reason those two providers'
// own *.test.ts files fail to load in this repo (see vitest.config.ts's
// coverage-threshold comment). Importing index.ts here would hit that same
// failure. So this test registers 'anthropic' directly against the real
// LLMProviderRegistry using the exact factory line index.ts uses, without
// pulling in the other providers' modules.
LLMProviderRegistry.register(
  'anthropic',
  (config) => new AnthropicProvider(config as AnthropicProviderConfig)
);

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    generateTextMock.mockReset();
    streamTextMock.mockReset();
    provider = new AnthropicProvider({
      name: 'anthropic',
      apiKey: 'test-api-key',
      defaultModel: 'claude-3-5-sonnet-latest',
    });
  });

  describe('constructor', () => {
    it('should create provider with valid config', () => {
      expect(provider).toBeDefined();
      expect(provider.name).toBe('anthropic');
    });

    it('should accept custom baseURL', () => {
      const customProvider = new AnthropicProvider({
        name: 'anthropic',
        apiKey: 'test-key',
        baseURL: 'https://custom.anthropic.com',
      });
      expect(customProvider).toBeDefined();
    });
  });

  describe('supportsTools', () => {
    it('should return true for Claude 3 models', () => {
      expect(provider.supportsTools('claude-3-5-sonnet-latest')).toBe(true);
      expect(provider.supportsTools('claude-3-opus-latest')).toBe(true);
      expect(provider.supportsTools('claude-3-haiku-20240307')).toBe(true);
    });

    it('should return false for unsupported models', () => {
      expect(provider.supportsTools('davinci')).toBe(false);
    });
  });

  describe('supportsStreaming', () => {
    it('should return true for all models', () => {
      expect(provider.supportsStreaming('claude-3-5-sonnet-latest')).toBe(true);
      expect(provider.supportsStreaming('any-model')).toBe(true);
    });
  });

  describe('getModels', () => {
    it('should return a non-empty list of common models', async () => {
      const models = await provider.getModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models).toContain('claude-3-5-sonnet-latest');
    });
  });

  describe('generate', () => {
    it('returns a GenerateResult with the same shape as OpenAIProvider for an equivalent prompt', async () => {
      generateTextMock.mockResolvedValue({
        text: 'Hello from Claude',
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        toolCalls: [],
      });

      const options: GenerateOptions = {
        model: 'claude-3-5-sonnet-latest',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      const result = await provider.generate(options);

      expect(result).toMatchObject({
        text: 'Hello from Claude',
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
      expect(result.rawResponse).toBeDefined();
    });

    it('converts tool calls the same way OpenAIProvider does', async () => {
      generateTextMock.mockResolvedValue({
        text: '',
        finishReason: 'tool-calls',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        toolCalls: [{ toolCallId: 'call_1', toolName: 'search', args: { query: 'x' } }],
      });

      const options: GenerateOptions = {
        model: 'claude-3-5-sonnet-latest',
        messages: [{ role: 'user', content: 'search for x' }],
        tools: [
          {
            type: 'function',
            function: { name: 'search', description: 'search', parameters: {} },
          },
        ],
      };

      const result = await provider.generate(options);

      expect(result.finishReason).toBe('tool_calls');
      expect(result.toolCalls).toEqual([
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'search', arguments: JSON.stringify({ query: 'x' }) },
        },
      ]);
    });
  });

  describe('stream', () => {
    it('returns a StreamResult whose fullStream yields text-delta then finish chunks, matching OpenAIProvider', async () => {
      async function* textStream() {
        yield 'Hel';
        yield 'lo';
      }

      streamTextMock.mockReturnValue({
        textStream: textStream(),
        text: Promise.resolve('Hello'),
        usage: Promise.resolve({ promptTokens: 3, completionTokens: 2, totalTokens: 5 }),
        finishReason: Promise.resolve('stop'),
        toolCalls: Promise.resolve([]),
      });

      const options: GenerateOptions = {
        model: 'claude-3-5-sonnet-latest',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      const streamResult = await provider.stream(options);
      const chunks = [];
      for await (const chunk of streamResult.fullStream) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toMatchObject({ type: 'text-delta' });
      expect(chunks[chunks.length - 1]).toMatchObject({
        type: 'finish',
        finishReason: 'stop',
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      });
      expect(await streamResult.text).toBe('Hello');
    });
  });

  describe('registry', () => {
    it('is retrievable via LLMProviderRegistry.create under the name "anthropic"', () => {
      expect(LLMProviderRegistry.has('anthropic')).toBe(true);
      const created = LLMProviderRegistry.create('anthropic', { apiKey: 'test-key' });
      expect(created).toBeInstanceOf(AnthropicProvider);
      expect(created.name).toBe('anthropic');
    });
  });
});
