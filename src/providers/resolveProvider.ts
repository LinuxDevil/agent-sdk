/**
 * resolveProvider("provider/model") helper (LOU-F8)
 *
 * Parses a "<provider>/<model>" spec string (e.g. "openai/gpt-4o",
 * "anthropic/claude-3-5-sonnet-latest"), looks up that provider's
 * credential/config env var, and delegates to the real
 * `LLMProviderRegistry.create()` (the same registry OpenAIProvider,
 * AnthropicProvider, OllamaProvider and OpenRouterProvider register
 * themselves into - see providers/index.ts) to construct the provider
 * instance, pre-configured with `defaultModel` set to the parsed model.
 */

import { PROVIDER_ENV_TABLE } from './providerEnv';
import { LLMProvider, LLMProviderConfig, LLMProviderRegistry } from './llm';

/**
 * Resolve a "<provider>/<model>" spec into a configured LLMProvider
 * instance.
 *
 * Throws a clear error for a spec that isn't "provider/model" shaped, or
 * whose provider prefix isn't recognized - both checked BEFORE any call
 * into LLMProviderRegistry, so an unrecognized provider never reaches
 * (and never gets a confusing error from) the registry itself.
 */
export function resolveProvider(spec: string): LLMProvider {
  const separatorIndex = spec.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === spec.length - 1) {
    throw new Error(
      `resolveProvider: expected a "<provider>/<model>" spec, got '${spec}'`
    );
  }

  const providerName = spec.slice(0, separatorIndex);
  const model = spec.slice(separatorIndex + 1);

  const envEntry = PROVIDER_ENV_TABLE[providerName.toLowerCase()];
  if (!envEntry) {
    throw new Error(
      `resolveProvider: unrecognized provider '${providerName}' in spec '${spec}'. ` +
        `Known providers: ${Object.keys(PROVIDER_ENV_TABLE).join(', ')}`
    );
  }

  const envValue = process.env[envEntry.envKey];

  const config: LLMProviderConfig = {
    defaultModel: model,
    [envEntry.configField]: envValue,
  };

  return LLMProviderRegistry.create(providerName.toLowerCase(), config);
}
