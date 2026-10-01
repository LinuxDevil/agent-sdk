import { describe, it, expect, vi, afterEach } from 'vitest';
import { LLMProviderRegistry, LLMProvider } from './llm';
import { resolveProvider } from './resolveProvider';

/** Matches an SDKError with this stable `code` (LOU-D2). */
const withCode = (code: string) => expect.objectContaining({ code });

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
    expect(() => resolveProvider('nonexistent/foo')).toThrow(withCode('LOUSHY_PROVIDER_UNKNOWN'));
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('throws for a spec that is not "provider/model" shaped', () => {
    expect(() => resolveProvider('openai')).toThrow();
    expect(() => resolveProvider('/gpt-4')).toThrow();
    expect(() => resolveProvider('openai/')).toThrow(withCode('LOUSHY_PROVIDER_SPEC_INVALID'));
  });
});

describe('resolveProvider errors (LOU-D1)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('names the env var when the API key is missing, without reaching the registry', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const createSpy = vi.spyOn(LLMProviderRegistry, 'create');

    expect(() => resolveProvider('openai/gpt-4o')).toThrow(
      'resolveProvider: OPENAI_API_KEY is not set. Set it in your environment, or pass a provider instance: createAgent({ provider: ... })'
    );
    expect(() => resolveProvider('openai/gpt-4o')).toThrow(withCode('LOUSHY_PROVIDER_MISSING_API_KEY'));
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('does not require an env var for ollama (it has a local default)', () => {
    vi.stubEnv('OLLAMA_BASE_URL', '');
    vi.spyOn(LLMProviderRegistry, 'create').mockReturnValue(fakeProvider('ollama'));

    expect(() => resolveProvider('ollama/llama3')).not.toThrow();
  });

  it('lists supported prefixes and suggests the closest match for a typo', () => {
    expect(() => resolveProvider('anthopic/claude-3')).toThrow(
      "unrecognized provider 'anthopic' in spec 'anthopic/claude-3'. Supported prefixes: openai, anthropic, openrouter, ollama. Did you mean 'anthropic/claude-3'?"
    );
  });

  it('lists supported prefixes without a suggestion when nothing is close', () => {
    expect(() => resolveProvider('zzzzzzzzzz/m')).toThrow(/Supported prefixes: openai, anthropic, openrouter, ollama\.$/m);
  });

  it('shows an example for a spec without a provider prefix', () => {
    expect(() => resolveProvider('gpt-4o')).toThrow(/Example: 'openai\/gpt-4o-mini'/);
  });

  it.each([
    [
      'openai/gpt-4o',
      'OPENAI_API_KEY',
      'npm install @ai-sdk/openai@^0.0.42 (ai 4); npm install @ai-sdk/openai@^3.0.0 (ai 6); npm install @ai-sdk/openai@^4.0.0 (ai 7)',
    ],
    [
      'openrouter/some-model',
      'OPENROUTER_API_KEY',
      'npm install @ai-sdk/openai@^0.0.42 (ai 4); npm install @ai-sdk/openai@^3.0.0 (ai 6); npm install @ai-sdk/openai@^4.0.0 (ai 7)',
    ],
    [
      'ollama/llama3',
      'OLLAMA_BASE_URL',
      'npm install ollama-ai-provider@^1.2.0 (ai 4); npm install ollama-ai-provider-v2@^3.0.0 (ai 6); npm install ollama-ai-provider-v2@^4.0.0 (ai 7)',
    ],
  ])('tells you the npm install command for each ai major when the peer for %s is missing', (spec, envKey, hint) => {
    vi.stubEnv(envKey, 'value');
    vi.spyOn(LLMProviderRegistry, 'create').mockImplementation(() => {
      throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' });
    });

    expect(() => resolveProvider(spec)).toThrow(`Run: ${hint}`);
    expect(() => resolveProvider(spec)).toThrow(withCode('LOUSHY_PEER_MISSING'));
  });

  it('rethrows unrelated registry errors unchanged', () => {
    vi.stubEnv('OPENAI_API_KEY', 'k');
    vi.spyOn(LLMProviderRegistry, 'create').mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() => resolveProvider('openai/gpt-4o')).toThrow('boom');
  });
});
