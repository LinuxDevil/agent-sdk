/**
 * OpenRouter Provider Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenRouterProvider, OpenRouterProviderConfig } from './OpenRouterProvider';
import { MessageRole } from './llm';

describe('OpenRouterProvider', () => {
  let config: OpenRouterProviderConfig;

  beforeEach(() => {
    config = {
      name: 'openrouter',
      apiKey: 'test-api-key',
      defaultModel: 'openai/gpt-3.5-turbo',
      siteUrl: 'https://example.com',
      siteName: 'Test Site',
    };
  });

  it('should initialize with correct config', () => {
    const provider = new OpenRouterProvider(config);
    expect(provider.name).toBe('openrouter');
  });

  it('should support tools for OpenAI models', () => {
    const provider = new OpenRouterProvider(config);
    expect(provider.supportsTools('openai/gpt-4')).toBe(true);
    expect(provider.supportsTools('openai/gpt-3.5-turbo')).toBe(true);
  });

  it('should support tools for Anthropic models', () => {
    const provider = new OpenRouterProvider(config);
    expect(provider.supportsTools('anthropic/claude-3.5-sonnet')).toBe(true);
    expect(provider.supportsTools('anthropic/claude-3-opus')).toBe(true);
  });

  it('should support tools for Google models', () => {
    const provider = new OpenRouterProvider(config);
    expect(provider.supportsTools('google/gemini-pro')).toBe(true);
  });

  it('should support tools for Mistral models', () => {
    const provider = new OpenRouterProvider(config);
    expect(provider.supportsTools('mistralai/mistral-large')).toBe(true);
  });

  it('should default to supporting tools for other/unknown models', () => {
    const provider = new OpenRouterProvider(config);
    expect(provider.supportsTools('meta-llama/llama-3.1-70b-instruct')).toBe(true);
    expect(provider.supportsTools('some-vendor/unknown-model')).toBe(true);
  });

  it('should support streaming for all models', () => {
    const provider = new OpenRouterProvider(config);
    expect(provider.supportsStreaming('openai/gpt-4')).toBe(true);
    expect(provider.supportsStreaming('anthropic/claude-3.5-sonnet')).toBe(true);
    expect(provider.supportsStreaming('meta-llama/llama-3.1-70b-instruct')).toBe(true);
  });

  describe('model catalog', () => {
    // OpenRouter's GET /models is a public endpoint: it answers 200 with the
    // live catalog even for an invalid API key, so these tests stub fetch
    // instead of depending on the network and on today's catalog contents.
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('should return fallback models when API fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
      ));
      const provider = new OpenRouterProvider({
        name: 'openrouter',
        apiKey: 'invalid-key',
      });

      const models = await provider.getModels();
      expect(models).toBeInstanceOf(Array);
      expect(models.length).toBeGreaterThan(0);
      expect(models).toContain('openai/gpt-4o');
      expect(models).toContain('anthropic/claude-3.5-sonnet');
    });

    it('should return fallback models when the network is unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
      const provider = new OpenRouterProvider(config);

      const models = await provider.getModels();
      expect(models).toContain('openai/gpt-4o');
    });

    it('should return model ids from the API when it succeeds', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'a/model-1' }, { id: 'b/model-2' }] }))
      );
      vi.stubGlobal('fetch', fetchMock);
      const provider = new OpenRouterProvider(config);

      expect(await provider.getModels()).toEqual(['a/model-1', 'b/model-2']);
      expect(fetchMock).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: 'Bearer test-api-key' },
      });
    });

    it('should look up model info by id, and return null on failure', async () => {
      // A fresh Response per call - a Response body can only be read once.
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
        new Response(JSON.stringify({ data: [{ id: 'a/model-1', pricing: { prompt: '1' } }] }))
      ));
      const provider = new OpenRouterProvider(config);
      expect(await provider.getModelInfo('a/model-1')).toEqual({ id: 'a/model-1', pricing: { prompt: '1' } });
      expect(await provider.getModelInfo('missing')).toBeUndefined();

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
      expect(await provider.getModelInfo('a/model-1')).toBeNull();
    });
  });

  it('should handle configuration without optional fields', () => {
    const minimalConfig: OpenRouterProviderConfig = {
      name: 'openrouter',
      apiKey: 'test-key',
    };
    
    const provider = new OpenRouterProvider(minimalConfig);
    expect(provider.name).toBe('openrouter');
  });
});
