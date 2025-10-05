/**
 * OpenRouter Provider Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
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

  it('should support streaming for all models', () => {
    const provider = new OpenRouterProvider(config);
    expect(provider.supportsStreaming('openai/gpt-4')).toBe(true);
    expect(provider.supportsStreaming('anthropic/claude-3.5-sonnet')).toBe(true);
    expect(provider.supportsStreaming('meta-llama/llama-3.1-70b-instruct')).toBe(true);
  });

  it('should return fallback models when API fails', async () => {
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

  it('should handle configuration without optional fields', () => {
    const minimalConfig: OpenRouterProviderConfig = {
      name: 'openrouter',
      apiKey: 'test-key',
    };
    
    const provider = new OpenRouterProvider(minimalConfig);
    expect(provider.name).toBe('openrouter');
  });
});
