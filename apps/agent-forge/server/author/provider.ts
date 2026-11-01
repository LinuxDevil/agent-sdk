/**
 * The Author's provider resolution: `'provider/model'` -> a real
 * `LLMProvider` built with the stored key (the secrets store wins over the
 * env var), or a `NO_PROVIDER_KEY` failure. Mirrors `buildAgent.ts`'s
 * `resolveProviderForSpec` key rules, but deliberately has no mock escape
 * hatch: with no usable key the Author shows a setup card instead of
 * pretending to answer (PLAN 16 decision 4).
 */
import { LLMProviderRegistry, type LLMProvider } from 'lousho';
import { PROVIDER_KEY_ENV, isSecretProvider, type SecretsStore } from '../secretsStore';

/** The outcome of {@link resolveAuthorProvider}: a ready provider, or why the Author cannot run. */
export type AuthorProviderResult =
  | { ok: true; provider: LLMProvider; modelId: string }
  | { ok: false; code: 'NO_PROVIDER_KEY'; provider: string; message: string };

/** The human name the missing-key copy uses for each provider. */
const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
};

/** The "no key" result: the Settings-card copy naming the provider, never a mock. */
function missingKey(provider: string): AuthorProviderResult {
  const label = PROVIDER_LABEL[provider] ?? provider;
  return {
    ok: false,
    code: 'NO_PROVIDER_KEY',
    provider,
    message: `Add an ${label} API key in Settings to use the Agent Author.`,
  };
}

/** The "not a provider the Author can run on" result (mock, an unknown name, a malformed id). */
function notUsable(provider: string, model: string): AuthorProviderResult {
  return {
    ok: false,
    code: 'NO_PROVIDER_KEY',
    provider,
    message: `The Agent Author model "${model}" is not available. Pick another model in Settings.`,
  };
}

/**
 * `'anthropic/claude-sonnet-5-5'` -> an anthropic provider holding the
 * stored key, else the env key; `'openai/...'` the same for its own key;
 * `'openrouter/...'` reads `OPENROUTER_API_KEY` only (the model id keeps
 * its nested `vendor/model` form); `'ollama/...'` needs no key. Anything
 * else - including `'mock'` - is not usable: the Author never falls back
 * to a fake model.
 */
export function resolveAuthorProvider(model: string, secrets: SecretsStore): AuthorProviderResult {
  const slash = model.indexOf('/');
  const provider = slash === -1 ? '' : model.slice(0, slash).toLowerCase();
  const modelId = slash === -1 ? '' : model.slice(slash + 1);
  if (provider === '' || modelId === '') {
    return notUsable(provider === '' ? model : provider, model);
  }

  let apiKey: string | undefined;
  if (isSecretProvider(provider)) {
    apiKey = secrets.getKey(provider) || process.env[PROVIDER_KEY_ENV[provider]];
    if (!apiKey) return missingKey(provider);
  } else if (provider === 'openrouter') {
    apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return missingKey(provider);
  } else if (provider !== 'ollama') {
    return notUsable(provider, model);
  }

  try {
    return { ok: true, provider: LLMProviderRegistry.create(provider, { defaultModel: modelId, apiKey }), modelId };
  } catch {
    return notUsable(provider, model);
  }
}
