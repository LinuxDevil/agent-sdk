/**
 * Ollama Provider Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OllamaProvider } from './OllamaProvider';

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

  // Note: Actual API calls are not tested to avoid external dependencies
  // Integration tests should be in a separate test suite
});
