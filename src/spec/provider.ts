/**
 * resolveSpecProvider(): the provider half of a spec's 'provider/model'
 * string. Shared by the v1 compiler (specToAgent) and the v2 compiler
 * (specV2ToAgent) so both resolve a model id the same way; kept in its own
 * module so the v2 compiler never has to import the v1 one.
 */
import { resolveProvider } from '../providers/resolveProvider';
import { LLMProvider, LLMProviderRegistry } from '../providers/llm';

const REAL_PROVIDER_TYPES = new Set(['openai', 'anthropic', 'google', 'ollama', 'openrouter']);

/**
 * Resolves a spec's provider config to an LLMProvider. Real provider types
 * go through resolveProvider() (env-var driven credentials, as
 * usual). Any other registered type - notably 'mock', which intentionally
 * has no env var and is never part of resolveProvider()'s whitelist - is
 * created directly via LLMProviderRegistry. This is what lets `lousho dev`
 * run end-to-end against a MockLLMProvider in tests without
 * real API credentials, while still reusing resolveProvider() verbatim for
 * every real provider type.
 *
 * No provider-registration side-effect import is needed here:
 * LLMProviderRegistry.create() - reached directly for non-real types, and
 * via resolveProvider() for the real ones - registers the built-in
 * providers lazily on a miss, so 'mock', 'openai', 'anthropic',
 * 'openrouter' and 'ollama' all resolve in CLI bundles like dist/cli/dev.js
 * that never load src/index.ts.
 */
export function resolveSpecProvider(type: string, model: string): LLMProvider {
  if (REAL_PROVIDER_TYPES.has(type.toLowerCase())) {
    return resolveProvider(`${type}/${model}`);
  }
  return LLMProviderRegistry.create(type, { defaultModel: model });
}
