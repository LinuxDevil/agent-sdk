import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LLMProviderRegistry, type LLMProvider } from 'lousho';
import { SecretsStore } from '../../secretsStore';
import { resolveAuthorProvider } from '../provider';

/**
 * resolveAuthorProvider: 'provider/model' -> a real LLMProvider built with
 * the stored key (secrets store wins over the env var), or a NO_PROVIDER_KEY
 * failure. It never falls back to mock - a missing key is a setup card, not
 * a fake reply (PLAN 16.4).
 */
describe('resolveAuthorProvider', () => {
  let dir: string;
  let secrets: SecretsStore;
  let createSpy: MockInstance;
  const fakeProvider = {} as LLMProvider;

  const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'] as const;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-aa02b-provider-'));
    secrets = new SecretsStore(dir);
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    createSpy = vi.spyOn(LLMProviderRegistry, 'create').mockReturnValue(fakeProvider);
  });

  afterEach(() => {
    createSpy.mockRestore();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the stored key wins over the env var', () => {
    secrets.setKey('anthropic', 'sk-stored');
    process.env.ANTHROPIC_API_KEY = 'sk-env';
    const result = resolveAuthorProvider('anthropic/claude-sonnet-5-5', secrets);
    expect(result).toEqual({ ok: true, provider: fakeProvider, modelId: 'claude-sonnet-5-5' });
    expect(createSpy).toHaveBeenCalledWith('anthropic', { defaultModel: 'claude-sonnet-5-5', apiKey: 'sk-stored' });
  });

  it('falls back to the env var when no key is stored', () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    const result = resolveAuthorProvider('openai/gpt-4o-mini', secrets);
    expect(result.ok).toBe(true);
    expect(createSpy).toHaveBeenCalledWith('openai', { defaultModel: 'gpt-4o-mini', apiKey: 'sk-env' });
  });

  it('openrouter reads OPENROUTER_API_KEY and keeps the nested model id', () => {
    process.env.OPENROUTER_API_KEY = 'or-env';
    const result = resolveAuthorProvider('openrouter/anthropic/claude-sonnet-5-5', secrets);
    expect(result).toEqual({ ok: true, provider: fakeProvider, modelId: 'anthropic/claude-sonnet-5-5' });
    expect(createSpy).toHaveBeenCalledWith('openrouter', {
      defaultModel: 'anthropic/claude-sonnet-5-5',
      apiKey: 'or-env',
    });
  });

  it('ollama needs no key', () => {
    const result = resolveAuthorProvider('ollama/llama3', secrets);
    expect(result).toEqual({ ok: true, provider: fakeProvider, modelId: 'llama3' });
    expect(createSpy).toHaveBeenCalledWith('ollama', { defaultModel: 'llama3', apiKey: undefined });
  });

  it('a missing anthropic key fails with the Settings copy, never a mock', () => {
    const result = resolveAuthorProvider('anthropic/claude-sonnet-5-5', secrets);
    expect(result).toEqual({
      ok: false,
      code: 'NO_PROVIDER_KEY',
      provider: 'anthropic',
      message: 'Add an Anthropic API key in Settings to use the Agent Author.',
    });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('a missing openai key names OpenAI', () => {
    const result = resolveAuthorProvider('openai/gpt-4o-mini', secrets);
    expect(result).toEqual({
      ok: false,
      code: 'NO_PROVIDER_KEY',
      provider: 'openai',
      message: 'Add an OpenAI API key in Settings to use the Agent Author.',
    });
  });

  it('a missing openrouter key names OpenRouter', () => {
    const result = resolveAuthorProvider('openrouter/x/y', secrets);
    expect(result).toEqual({
      ok: false,
      code: 'NO_PROVIDER_KEY',
      provider: 'openrouter',
      message: 'Add an OpenRouter API key in Settings to use the Agent Author.',
    });
  });

  it.each(['mock/mock-1', 'bogus/x', 'no-slash-at-all', 'anthropic/'])(
    '"%s" is not usable: the pick-another-model copy, provider never created',
    (model) => {
      const result = resolveAuthorProvider(model, secrets);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('NO_PROVIDER_KEY');
        expect(result.message).toBe(
          `The Agent Author model "${model}" is not available. Pick another model in Settings.`
        );
      }
      expect(createSpy).not.toHaveBeenCalled();
    }
  );
});
