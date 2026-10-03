/**
 * LOU-R1 regression tests: the built-in providers must resolve from ANY
 * import path, not just after `src/index.ts` (or `src/providers/index.ts`)
 * has been imported for its side-effect registrations.
 *
 * This file deliberately imports only deep modules - './llm',
 * './resolveProvider', the provider classes - never a barrel. Before
 * LOU-R1 every assertion below failed with
 * `Provider 'openrouter' not found. Available: mock`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { LLMProviderRegistry } from './llm';
import { resolveProvider } from './resolveProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import { MockLLMProvider, createMockProvider } from './mock';
import { resolveSpecProvider } from '../spec/specToAgent';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('LLMProviderRegistry.create() resolves the built-ins on a deep import (LOU-R1)', () => {
  it.each(['openai', 'anthropic', 'openrouter', 'ollama', 'mock'])(
    "create('%s', ...) does not throw and returns that provider",
    (name) => {
      const provider = LLMProviderRegistry.create(name, { apiKey: 'x' });
      expect(provider.name).toBe(name);
    }
  );

  it("create('openrouter') returns the real OpenRouterProvider", () => {
    expect(LLMProviderRegistry.create('openrouter', { apiKey: 'x' })).toBeInstanceOf(OpenRouterProvider);
  });

  it("still throws for an unknown name, now listing every built-in", () => {
    expect(() => LLMProviderRegistry.create('nope', {})).toThrow("Provider 'nope' not found");
    expect(() => LLMProviderRegistry.create('nope', {})).toThrow(/openai/);
  });

  it('never overwrites a factory the caller registered itself', () => {
    const custom = createMockProvider({ name: 'mock', responses: ['hi'] });
    LLMProviderRegistry.register('mock', () => custom);
    expect(LLMProviderRegistry.create('mock', {})).toBe(custom);
  });
});

describe('resolveProvider() resolves a "<provider>/<model>" spec on a deep import (LOU-R1)', () => {
  it("resolveProvider('openrouter/<model>') returns an OpenRouterProvider", () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-dummy');
    const provider = resolveProvider('openrouter/some-model');
    expect(provider).toBeInstanceOf(OpenRouterProvider);
    expect(provider.defaultModel).toBe('some-model');
  });
});

describe('specToAgent provider resolution (the `lousho dev`/`chat` path, LOU-R1)', () => {
  it("resolveSpecProvider('mock', ...) returns a MockLLMProvider", () => {
    expect(resolveSpecProvider('mock', 'mock-model')).toBeInstanceOf(MockLLMProvider);
  });

  it("resolveSpecProvider('openrouter', ...) resolves through env credentials", () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-dummy');
    const provider = resolveSpecProvider('openrouter', 'openai/gpt-4o-mini');
    expect(provider).toBeInstanceOf(OpenRouterProvider);
    expect(provider.defaultModel).toBe('openai/gpt-4o-mini');
  });
});
