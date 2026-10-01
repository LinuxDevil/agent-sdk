/**
 * Ollama Provider Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OllamaProvider } from './OllamaProvider';
import { itOnAiV4 } from './aiMajor.testkit';

describe('OllamaProvider', () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    provider = new OllamaProvider({
      name: 'ollama',
      baseURL: 'http://localhost:11434',
      defaultModel: 'llama3.1',
    });
  });

  describe('constructor', () => {
    it('should create provider with valid config', () => {
      expect(provider).toBeDefined();
      expect(provider.name).toBe('ollama');
    });

    it('should use default baseURL if not provided', () => {
      const defaultProvider = new OllamaProvider({
        name: 'ollama',
      });
      expect(defaultProvider).toBeDefined();
    });
  });

  describe('supportsTools', () => {
    it('should return true for llama3 models', () => {
      expect(provider.supportsTools('llama3')).toBe(true);
      expect(provider.supportsTools('llama3.1')).toBe(true);
    });

    it('should return true for mistral models', () => {
      expect(provider.supportsTools('mistral')).toBe(true);
      expect(provider.supportsTools('mistral-7b')).toBe(true);
    });

    it('should return false for unsupported models', () => {
      expect(provider.supportsTools('llama2')).toBe(false);
      expect(provider.supportsTools('codellama')).toBe(false);
    });
  });

  describe('supportsStreaming', () => {
    it('should return true for all models', () => {
      expect(provider.supportsStreaming('llama3.1')).toBe(true);
      expect(provider.supportsStreaming('mistral')).toBe(true);
      expect(provider.supportsStreaming('any-model')).toBe(true);
    });
  });

  describe('getModels', () => {
    it('should return fallback models on error or actual models', async () => {
      const models = await provider.getModels();
      expect(models.length).toBeGreaterThan(0);
      // Should either be real models from Ollama or fallback models
      expect(Array.isArray(models)).toBe(true);
    });
  });

  // LOU-D28f: both Ollama packages expect a base URL ending in `/api` (their default is
  // http://localhost:11434/api); a bare host is completed, anything with a path is kept.
  describe('base URL', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const cases: Array<[string, string | undefined, string]> = [
      ['unset (the local default)', undefined, 'http://localhost:11434/api/tags'],
      ['a bare host', 'http://host:11434', 'http://host:11434/api/tags'],
      ['a bare host with a trailing slash', 'http://host:11434/', 'http://host:11434/api/tags'],
      ['already ending in /api', 'http://host:11434/api', 'http://host:11434/api/tags'],
      ['already ending in /api/', 'http://host:11434/api/', 'http://host:11434/api/tags'],
      ['another explicit path', 'https://proxy.example.com/ollama', 'https://proxy.example.com/ollama/tags'],
      ['another explicit path with a trailing slash', 'https://proxy.example.com/ollama/', 'https://proxy.example.com/ollama/tags'],
    ];

    it.each(cases)('getModels() asks the right URL for %s', async (_form, baseURL, expected) => {
      const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ models: [{ name: 'm1' }] })));
      vi.stubGlobal('fetch', fetchMock);
      const models = await new OllamaProvider({ name: 'ollama', baseURL }).getModels();
      expect(models).toEqual(['m1']);
      expect(fetchMock).toHaveBeenCalledWith(expected);
    });

    // The model request goes through `ollama-ai-provider` (the `ai` 4 package, installed by default).
    itOnAiV4.each(cases)('chat requests go to /api/chat for %s', async (_form, baseURL, expected) => {
      const fetchMock = vi.fn().mockImplementation(async () => new Response('{}', { status: 400 }));
      vi.stubGlobal('fetch', fetchMock);
      const ollama = new OllamaProvider({ name: 'ollama', baseURL });
      await expect(ollama.generate({ messages: [{ role: 'user', content: 'hi' }], model: 'llama3.1' })).rejects.toThrow();
      expect(String(fetchMock.mock.calls[0][0])).toBe(expected.replace(/\/tags$/, '/chat'));
    });
  });

  // Note: Actual API calls are not tested to avoid external dependencies
  // Integration tests should be in a separate test suite
});
