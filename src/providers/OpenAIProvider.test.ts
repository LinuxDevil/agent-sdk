/**
 * OpenAI Provider Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenAIProvider } from './OpenAIProvider';

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    provider = new OpenAIProvider({
      name: 'openai',
      apiKey: 'test-api-key',
      defaultModel: 'gpt-4',
    });
  });

  describe('constructor', () => {
    it('should create provider with valid config', () => {
      expect(provider).toBeDefined();
      expect(provider.name).toBe('openai');
    });

    it('should accept custom baseURL', () => {
      const customProvider = new OpenAIProvider({
        name: 'openai',
        apiKey: 'test-key',
        baseURL: 'https://custom.openai.com',
      });
      expect(customProvider).toBeDefined();
    });
  });

  describe('supportsTools', () => {
    it('should return true for GPT-4 models', () => {
      expect(provider.supportsTools('gpt-4')).toBe(true);
      expect(provider.supportsTools('gpt-4-turbo')).toBe(true);
      expect(provider.supportsTools('gpt-4o')).toBe(true);
    });

    it('should return true for GPT-3.5-turbo', () => {
      expect(provider.supportsTools('gpt-3.5-turbo')).toBe(true);
    });

    it('should return false for unsupported models', () => {
      expect(provider.supportsTools('davinci')).toBe(false);
    });
  });

  describe('supportsStreaming', () => {
    it('should return true for all models', () => {
      expect(provider.supportsStreaming('gpt-4')).toBe(true);
      expect(provider.supportsStreaming('gpt-3.5-turbo')).toBe(true);
      expect(provider.supportsStreaming('any-model')).toBe(true);
    });
  });

  describe('getModels', () => {
    it('should return list of common models', async () => {
      const models = await provider.getModels();
      expect(models).toContain('gpt-4');
      expect(models).toContain('gpt-4o');
      expect(models).toContain('gpt-3.5-turbo');
    });
  });

  describe('request path', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // Audit C5: OpenAI-compatible servers that only implement Chat Completions (llama.cpp, vLLM, Ollama's /v1).
    it("api: 'chat' calls <baseURL>/chat/completions", async () => {
      const fetchMock = vi.fn().mockImplementation(
        async () => new Response(JSON.stringify({ error: { message: 'stub' } }), { status: 400 })
      );
      vi.stubGlobal('fetch', fetchMock);
      const local = new OpenAIProvider({ name: 'openai', apiKey: 'any', baseURL: 'http://localhost:1234/v1', api: 'chat', maxRetries: 0 });
      await expect(local.generate({ messages: [{ role: 'user', content: 'hi' }], model: 'qwen3' })).rejects.toThrow();
      expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:1234/v1/chat/completions');
    });
  });

  // Note: Actual API calls are not tested to avoid external dependencies
  // Integration tests should be in a separate test suite
});
