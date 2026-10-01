/**
 * LOU-H1 test: only imports createAgent() and a mock provider - zero other
 * Loushy imports - to prove the one-liner surface is self-contained.
 * LOU-D1 additions: `model` strings, env fallback, `instructions` alias and
 * error messages (no network: env is stubbed and the registry's create() is
 * the same boundary resolveProvider.test.ts mocks).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createAgent } from './createAgent';
import { createMockProvider } from './providers/mock';
import { LLMProviderRegistry } from './providers/llm';
import { mockModel } from './testing';

const ENV_VARS = ['LOUSHY_MODEL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_BASE_URL'];

describe('createAgent', () => {
  beforeEach(() => {
    for (const name of ENV_VARS) vi.stubEnv(name, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('sends a message and gets a non-empty response', async () => {
    const agent = createAgent({
      prompt: 'You are a helpful assistant.',
      provider: createMockProvider({ responses: ['Hello there!'] }),
    });

    const result = await agent.send('hi');

    expect(result.text).toBeTruthy();
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('throws a guiding error when provider is missing', () => {
    expect(() => createAgent({ prompt: 'x', provider: undefined })).toThrow(/provider/i);
  });

  describe('model string', () => {
    it('resolves "provider/model" with the key from the conventional env var', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-test');
      const provider = mockModel(['Hi from the model']);
      const createSpy = vi.spyOn(LLMProviderRegistry, 'create').mockReturnValue(provider);

      const agent = createAgent({ model: 'openai/gpt-4o-mini', instructions: 'Be brief.' });
      const { text } = await agent.send('Hello!');

      // maxRetries: 0 - createAgent() retries in its own withRetry() wrapper (LOU-V7.2).
      expect(createSpy).toHaveBeenCalledWith('openai', { maxRetries: 0, defaultModel: 'gpt-4o-mini', apiKey: 'sk-test' });
      expect(text).toBe('Hi from the model');
    });

    it('works with instructions omitted (minimal default prompt)', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-test');
      const provider = mockModel(['ok']);
      vi.spyOn(LLMProviderRegistry, 'create').mockReturnValue(provider);

      await createAgent({ model: 'openai/gpt-4o-mini' }).send('hi');

      expect(JSON.stringify(provider.lastCall?.messages)).toContain('You are a helpful assistant.');
    });

    it('with both provider and model: uses provider, and model is the per-agent model setting', async () => {
      const provider = mockModel(['ok']);
      const createSpy = vi.spyOn(LLMProviderRegistry, 'create');

      await createAgent({ provider, model: 'gpt-4o' }).send('hi');

      expect(createSpy).not.toHaveBeenCalled();
      expect(provider.lastCall?.model).toBe('gpt-4o');
    });
  });

  describe('environment fallback', () => {
    it('uses LOUSHY_MODEL when set, even if provider keys are present', () => {
      vi.stubEnv('LOUSHY_MODEL', 'anthropic/claude-3-5-haiku-latest');
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant');
      vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
      const createSpy = vi.spyOn(LLMProviderRegistry, 'create').mockReturnValue(mockModel([]));

      createAgent({ instructions: 'x' });

      expect(createSpy).toHaveBeenCalledWith('anthropic', {
        maxRetries: 0,
        defaultModel: 'claude-3-5-haiku-latest',
        apiKey: 'sk-ant',
      });
    });

    it.each([
      [{ OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a', OPENROUTER_API_KEY: 'r' }, 'openai'],
      [{ ANTHROPIC_API_KEY: 'a', OPENROUTER_API_KEY: 'r', OLLAMA_BASE_URL: 'http://x' }, 'anthropic'],
      [{ OPENROUTER_API_KEY: 'r', OLLAMA_BASE_URL: 'http://x' }, 'openrouter'],
      [{ OLLAMA_BASE_URL: 'http://x' }, 'ollama'],
    ])('with keys %j picks %s first', (env, expected) => {
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      const createSpy = vi.spyOn(LLMProviderRegistry, 'create').mockReturnValue(mockModel([]));

      createAgent();

      expect(createSpy.mock.calls[0][0]).toBe(expected);
    });

    it('throws an error listing every fix when nothing is configured', () => {
      expect(() => createAgent({ instructions: 'x' })).toThrow(
        /createAgent: no model configured.*model: 'openai\/gpt-4o-mini'.*provider: \.\.\..*LOUSHY_MODEL.*OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OLLAMA_BASE_URL/
      );
      expect(() => createAgent({ instructions: 'x' })).toThrow(
        expect.objectContaining({ code: 'LOUSHY_CONFIG_MISSING_PROVIDER', hint: expect.stringContaining('createAgent') })
      );
    });
  });

  describe('instructions / prompt', () => {
    it('accepts instructions as the system prompt', async () => {
      const provider = mockModel(['ok']);
      await createAgent({ provider, instructions: 'Answer in French.' }).send('hi');
      expect(JSON.stringify(provider.lastCall?.messages)).toContain('Answer in French.');
    });

    it('still accepts prompt as an alias', async () => {
      const provider = mockModel(['ok']);
      await createAgent({ provider, prompt: 'Answer in German.' }).send('hi');
      expect(JSON.stringify(provider.lastCall?.messages)).toContain('Answer in German.');
    });

    it('throws naming both when instructions and prompt are given', () => {
      const provider = mockModel([]);
      const both = { provider, instructions: 'a', prompt: 'b' } as unknown as Parameters<typeof createAgent>[0];
      expect(() => createAgent(both)).toThrow(/both 'instructions' and 'prompt'/);
      expect(() => createAgent(both)).toThrow(expect.objectContaining({ code: 'LOUSHY_CONFIG_CONFLICTING_OPTIONS' }));
    });
  });

  describe('error messages', () => {
    it('names the missing API key and the provider escape hatch', () => {
      expect(() => createAgent({ model: 'openai/gpt-4o-mini' })).toThrow(
        'createAgent: OPENAI_API_KEY is not set. Set it in your environment, or pass a provider instance: createAgent({ provider: ... })'
      );
    });

    it('lists supported prefixes and suggests the closest for an unknown provider', () => {
      expect(() => createAgent({ model: 'opnai/gpt-4o' })).toThrow(
        /createAgent: unrecognized provider 'opnai'.*Supported prefixes: openai, anthropic, openrouter, ollama\. Did you mean 'openai\/gpt-4o'\?/
      );
    });

    it('gives the exact npm install command when a peer dependency is missing', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant');
      vi.spyOn(LLMProviderRegistry, 'create').mockImplementation(() => {
        throw Object.assign(new Error("Cannot find module '@ai-sdk/anthropic'"), { code: 'MODULE_NOT_FOUND' });
      });

      expect(() => createAgent({ model: 'anthropic/claude-3-5-sonnet-latest' })).toThrow(
        /createAgent: .*'anthropic' provider.*Run: npm install @ai-sdk\/anthropic@\^0\.0\.42/
      );
    });
  });
});
