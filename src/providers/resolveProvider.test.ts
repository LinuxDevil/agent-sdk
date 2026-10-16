import { describe, it, expect, vi, afterEach } from 'vitest';
import { LLMProviderRegistry, LLMProvider } from './llm';
import { resolveProvider } from './resolveProvider';

/** Matches an SDKError with this stable `code`. */
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

  it('resolves "google/<model>" using GOOGLE_GENERATIVE_AI_API_KEY', () => {
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'test-google-key');
    const createSpy = vi.spyOn(LLMProviderRegistry, 'create').mockReturnValue(fakeProvider('google'));

    resolveProvider('google/gemini-2.5-flash');

    expect(createSpy).toHaveBeenCalledWith('google', { defaultModel: 'gemini-2.5-flash', apiKey: 'test-google-key' });
  });

  it('requires GOOGLE_GENERATIVE_AI_API_KEY for "google/<model>"', () => {
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', '');
    expect(() => resolveProvider('google/gemini-2.5-flash')).toThrow(withCode('LOUSHO_PROVIDER_MISSING_API_KEY'));
    expect(() => resolveProvider('google/gemini-2.5-flash')).toThrow('GOOGLE_GENERATIVE_AI_API_KEY is not set');
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
    expect(() => resolveProvider('nonexistent/foo')).toThrow(withCode('LOUSHO_PROVIDER_UNKNOWN'));
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('throws for a spec that is not "provider/model" shaped', () => {
    expect(() => resolveProvider('openai')).toThrow();
    expect(() => resolveProvider('/gpt-4')).toThrow();
    expect(() => resolveProvider('openai/')).toThrow(withCode('LOUSHO_PROVIDER_SPEC_INVALID'));
  });
});

describe('resolveProvider errors', () => {
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
    expect(() => resolveProvider('openai/gpt-4o')).toThrow(withCode('LOUSHO_PROVIDER_MISSING_API_KEY'));
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('under cassette replay resolves a spec without the key; a call that reaches it reports the missing key', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('LOUSHO_EVAL_CASSETTES', 'replay');
    const fake = Object.assign(fakeProvider('openai'), { defaultModel: 'gpt-4o-mini' });
    vi.spyOn(LLMProviderRegistry, 'create').mockReturnValue(fake);

    const provider = resolveProvider('openai/gpt-4o-mini');

    expect(provider.name).toBe('openai');
    expect(provider.defaultModel).toBe('gpt-4o-mini');
    await expect(provider.generate({ messages: [] })).rejects.toThrow('OPENAI_API_KEY is not set');
    await expect(provider.generate({ messages: [] })).rejects.toThrow(withCode('LOUSHO_PROVIDER_MISSING_API_KEY'));
    await expect(provider.getModels()).rejects.toThrow(withCode('LOUSHO_PROVIDER_MISSING_API_KEY'));
  });

  it.each(['', 'record'])('still requires the key when LOUSHO_EVAL_CASSETTES is %s', async (mode) => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('LOUSHO_EVAL_CASSETTES', mode);
    const createSpy = vi.spyOn(LLMProviderRegistry, 'create');

    expect(() => resolveProvider('openai/gpt-4o')).toThrow(withCode('LOUSHO_PROVIDER_MISSING_API_KEY'));
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('does not require an env var for ollama (it has a local default)', () => {
    vi.stubEnv('OLLAMA_BASE_URL', '');
    vi.spyOn(LLMProviderRegistry, 'create').mockReturnValue(fakeProvider('ollama'));

    expect(() => resolveProvider('ollama/llama3')).not.toThrow();
  });

  it('lists supported prefixes and suggests the closest match for a typo', () => {
    expect(() => resolveProvider('anthopic/claude-3')).toThrow(
      "unrecognized provider 'anthopic' in spec 'anthopic/claude-3'. Supported prefixes: openai, anthropic, openrouter, google, ollama, pi, mock. Did you mean 'anthropic/claude-3'?"
    );
    expect(() => resolveProvider('anthopic/claude-3')).not.toThrow(/openrouter\/anthopic/);
  });

  it('suggests OpenRouter and fromAiSdk() for a prefix that is not close to a supported one', () => {
    expect(() => resolveProvider('zzzzzzzzzz/m')).toThrow(
      "Supported prefixes: openai, anthropic, openrouter, google, ollama, pi, mock. To use 'zzzzzzzzzz' anyway: " +
        "'openrouter/zzzzzzzzzz/m' (OpenRouter serves most vendors; needs OPENROUTER_API_KEY), " +
        "or createAgent({ provider: fromAiSdk(zzzzzzzzzz('m')) }) with the vendor's own AI SDK provider package."
    );
    expect(() => resolveProvider('zzzzzzzzzz/m')).not.toThrow(/'pi\//);
  });

  it('also suggests pi for a vendor pi serves, and never mistakes it for a typo of a built-in prefix', () => {
    // 'xai' is two edits from 'pi', but it is a vendor of its own.
    const error = (() => {
      try {
        resolveProvider('xai/grok-4');
        return undefined;
      } catch (e) {
        return e as Error & { code: string };
      }
    })();
    expect(error?.code).toBe('LOUSHO_PROVIDER_UNKNOWN');
    expect(error?.message).not.toContain('Did you mean');
    expect(error?.message).toContain(
      "To use 'xai' anyway: 'openrouter/xai/grok-4' (OpenRouter serves most vendors; needs OPENROUTER_API_KEY), " +
        "'pi/xai/grok-4' (through @earendil-works/pi-ai), or createAgent({ provider: fromAiSdk(xai('grok-4')) })"
    );
    // The appended help line links the error code's docs section.
    expect(error?.message).toMatch(/\[LOUSHO_PROVIDER_UNKNOWN\].*docs\/errors\.md#lousho_provider_unknown/);
  });

  it('turns a dashed vendor into a valid AI SDK factory name', () => {
    expect(() => resolveProvider('amazon-bedrock/claude')).toThrow("fromAiSdk(amazonBedrock('claude'))");
  });

  it('every vendor it suggests through pi is one pi-ai serves', async () => {
    const { PI_NESTED_VENDORS } = await import('./providerSpec');
    const { getProviders } = await import('@earendil-works/pi-ai/compat');
    const known = new Set<string>(getProviders());
    expect(PI_NESTED_VENDORS.filter((vendor) => !known.has(vendor))).toEqual([]);
  });

  it('shows an example for a spec without a provider prefix', () => {
    expect(() => resolveProvider('gpt-4o')).toThrow(/Example: 'openai\/gpt-4.1-mini'/);
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
      'google/gemini-2.5-flash',
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'npm install @ai-sdk/google@^1.2.0 (ai 4); npm install @ai-sdk/google@^3.0.0 (ai 6); npm install @ai-sdk/google@^4.0.0 (ai 7)',
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
    expect(() => resolveProvider(spec)).toThrow(withCode('LOUSHO_PEER_MISSING'));
  });

  it('resolves "<name>/<model>" for a provider added with LLMProviderRegistry.register()', () => {
    const factory = vi.fn((config: { defaultModel?: string }) => ({ ...fakeProvider('f13-custom'), defaultModel: config.defaultModel }) as unknown as LLMProvider);
    LLMProviderRegistry.register('f13-custom', factory);

    const provider = resolveProvider('F13-Custom/some-model');

    expect(provider.name).toBe('f13-custom');
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ defaultModel: 'some-model' }));
  });

  it('resolves "mock/<model>" before any provider was registered (an entry point that never loaded the root)', () => {
    vi.spyOn(LLMProviderRegistry, 'has').mockReturnValue(false);

    const provider = resolveProvider('mock/mock-1');

    expect(provider.name).toBe('mock');
    expect(provider.defaultModel).toBe('mock-1');
  });

  it('still rejects a provider that is neither built in nor registered', () => {
    expect(() => resolveProvider('f13-nobody/some-model')).toThrow(withCode('LOUSHO_PROVIDER_UNKNOWN'));
  });

  it('rethrows unrelated registry errors unchanged', () => {
    vi.stubEnv('OPENAI_API_KEY', 'k');
    vi.spyOn(LLMProviderRegistry, 'create').mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() => resolveProvider('openai/gpt-4o')).toThrow('boom');
  });
});
