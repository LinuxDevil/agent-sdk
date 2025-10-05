import { describe, it, expect, beforeEach } from 'vitest';
import { LLMProviderRegistry } from './llm';
import { MockLLMProvider, createMockProvider } from './mock';

describe('LLM Providers', () => {
  describe('LLMProviderRegistry', () => {
    beforeEach(() => {
      LLMProviderRegistry.clear();
    });

    it('should register provider', () => {
      LLMProviderRegistry.register('mock', createMockProvider);
      expect(LLMProviderRegistry.has('mock')).toBe(true);
    });

    it('should create provider instance', () => {
      LLMProviderRegistry.register('mock', createMockProvider);
      const provider = LLMProviderRegistry.create('mock', { name: 'mock' });
      expect(provider).toBeInstanceOf(MockLLMProvider);
    });

    it('should be case-insensitive', () => {
      LLMProviderRegistry.register('MOCK', createMockProvider);
      expect(LLMProviderRegistry.has('mock')).toBe(true);
      expect(LLMProviderRegistry.has('Mock')).toBe(true);
    });

    it('should throw error for unknown provider', () => {
      expect(() => {
        LLMProviderRegistry.create('unknown', { name: 'unknown' });
      }).toThrow("Provider 'unknown' not found");
    });

    it('should return provider names', () => {
      LLMProviderRegistry.register('mock', createMockProvider);
      LLMProviderRegistry.register('test', createMockProvider);
      const names = LLMProviderRegistry.getProviderNames();
      expect(names).toContain('mock');
      expect(names).toContain('test');
    });

    it('should clear all providers', () => {
      LLMProviderRegistry.register('mock', createMockProvider);
      LLMProviderRegistry.clear();
      expect(LLMProviderRegistry.has('mock')).toBe(false);
    });
  });

  describe('MockLLMProvider', () => {
    let provider: MockLLMProvider;

    beforeEach(() => {
      provider = createMockProvider({
        name: 'mock',
        responses: ['Hello, world!', 'Second response'],
      });
    });

    it('should have correct name', () => {
      expect(provider.name).toBe('mock');
    });

    it('should generate text', async () => {
      const result = await provider.generate({
        model: 'mock-model',
        messages: [
          { role: 'user', content: 'Hello' }
        ],
      });

      expect(result.text).toBe('Hello, world!');
      expect(result.finishReason).toBe('stop');
      expect(result.usage.totalTokens).toBeGreaterThan(0);
    });

    it('should cycle through responses', async () => {
      const result1 = await provider.generate({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Test' }],
      });

      const result2 = await provider.generate({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Test' }],
      });

      const result3 = await provider.generate({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Test' }],
      });

      expect(result1.text).toBe('Hello, world!');
      expect(result2.text).toBe('Second response');
      expect(result3.text).toBe('Hello, world!'); // Cycles back
    });

    it('should calculate token usage', async () => {
      const result = await provider.generate({
        model: 'mock-model',
        messages: [
          { role: 'user', content: 'This is a test message' }
        ],
      });

      expect(result.usage.promptTokens).toBeGreaterThan(0);
      expect(result.usage.completionTokens).toBeGreaterThan(0);
      expect(result.usage.totalTokens).toBe(
        result.usage.promptTokens + result.usage.completionTokens
      );
    });

    it('should stream text', async () => {
      const result = await provider.stream({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      const chunks: string[] = [];
      for await (const chunk of result.textStream) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.join('')).toBe('Hello, world! ');
    });

    it('should stream with full chunks', async () => {
      const result = await provider.stream({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      const chunks = [];
      for await (const chunk of result.fullStream) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].type).toBe('text-delta');
      expect(chunks[chunks.length - 1].type).toBe('finish');
    });

    it('should resolve text promise', async () => {
      const result = await provider.stream({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      const text = await result.text;
      expect(text).toBe('Hello, world!');
    });

    it('should resolve usage promise', async () => {
      const result = await provider.stream({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      const usage = await result.usage;
      expect(usage.totalTokens).toBeGreaterThan(0);
    });

    it('should support tools', () => {
      expect(provider.supportsTools('any-model')).toBe(true);
    });

    it('should support streaming', () => {
      expect(provider.supportsStreaming('any-model')).toBe(true);
    });

    it('should return available models', async () => {
      const models = await provider.getModels();
      expect(models).toContain('mock-model-1');
      expect(models).toContain('mock-model-2');
    });

    it('should simulate tool calls', async () => {
      const result = await provider.generate({
        model: 'mock-model',
        messages: [
          { role: 'user', content: 'Call the getCurrentDate function' }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'getCurrentDate',
              description: 'Get current date',
              parameters: {},
            },
          },
        ],
      });

      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls!.length).toBeGreaterThan(0);
      expect(result.toolCalls![0].function.name).toBe('getCurrentDate');
      expect(result.finishReason).toBe('tool_calls');
    });

    it('should handle delay', async () => {
      const slowProvider = createMockProvider({
        name: 'mock',
        delay: 100,
      });

      const start = Date.now();
      await slowProvider.generate({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hello' }],
      });
      const duration = Date.now() - start;

      expect(duration).toBeGreaterThanOrEqual(90); // Allow some variance
    });

    it('should simulate errors', async () => {
      const errorProvider = createMockProvider({
        name: 'mock',
        simulateError: true,
        errorMessage: 'Test error',
      });

      await expect(
        errorProvider.generate({
          model: 'mock-model',
          messages: [{ role: 'user', content: 'Hello' }],
        })
      ).rejects.toThrow('Test error');
    });

    it('should simulate errors in streaming', async () => {
      const errorProvider = createMockProvider({
        name: 'mock',
        simulateError: true,
        errorMessage: 'Stream error',
      });

      await expect(
        errorProvider.stream({
          model: 'mock-model',
          messages: [{ role: 'user', content: 'Hello' }],
        })
      ).rejects.toThrow('Stream error');
    });
  });
});
