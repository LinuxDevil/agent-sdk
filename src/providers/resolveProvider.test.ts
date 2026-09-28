import { describe, it, expect, vi, afterEach } from 'vitest';
import { LLMProviderRegistry, LLMProvider } from './llm';
import { resolveProvider } from './resolveProvider';

function fakeProvider(name: string): LLMProvider {
  return {
    name,
    generate: vi.fn(),
    stream: vi.fn(),
    supportsTools: () => true,
    supportsStreaming: () => true,
    getModels: async () => [],
  } as unknown as LLMProvider;
}

describe('resolveProvider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('resolves "openai/<model>" using OPENAI_API_KEY and the real registry create()', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-openai-key');
    const createSpy = vi
      .spyOn(LLMProviderRegistry, 'create')
      .mockReturnValue(fakeProvider('openai'));

    const provider = resolveProvider('openai/gpt-5.6-sol');

    expect(createSpy).toHaveBeenCalledWith('openai', {
      defaultModel: 'gpt-5.6-sol',
      apiKey: 'sk-test-openai-key',
    });
    expect(provider.name).toBe('openai');
  });

  it('resolves "anthropic/<model>" using ANTHROPIC_API_KEY', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic-key');
    const createSpy = vi
      .spyOn(LLMProviderRegistry, 'create')
      .mockReturnValue(fakeProvider('anthropic'));

    resolveProvider('anthropic/claude-3-5-sonnet-latest');

    expect(createSpy).toHaveBeenCalledWith('anthropic', {
      defaultModel: 'claude-3-5-sonnet-latest',
      apiKey: 'sk-test-anthropic-key',
    });
  });

  it('resolves "ollama/<model>" into baseURL (not apiKey), since Ollama has no API key concept', () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    const createSpy = vi
      .spyOn(LLMProviderRegistry, 'create')
      .mockReturnValue(fakeProvider('ollama'));

    resolveProvider('ollama/llama3');

    expect(createSpy).toHaveBeenCalledWith('ollama', {
      defaultModel: 'llama3',
      baseURL: 'http://localhost:11434',
    });
  });

  it('resolves "openrouter/<model>" using OPENROUTER_API_KEY', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test-openrouter-key');
    const createSpy = vi
      .spyOn(LLMProviderRegistry, 'create')
      .mockReturnValue(fakeProvider('openrouter'));

    resolveProvider('openrouter/some-model');

    expect(createSpy).toHaveBeenCalledWith('openrouter', {
      defaultModel: 'some-model',
      apiKey: 'sk-test-openrouter-key',
    });
  });

  it('throws for an unrecognized provider prefix, before reaching the registry', () => {
    const createSpy = vi.spyOn(LLMProviderRegistry, 'create');

    expect(() => resolveProvider('nonexistent/foo')).toThrow(/unrecognized provider/i);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('throws for a spec that is not "provider/model" shaped', () => {
    expect(() => resolveProvider('openai')).toThrow();
    expect(() => resolveProvider('/gpt-4')).toThrow();
    expect(() => resolveProvider('openai/')).toThrow();
  });
});
