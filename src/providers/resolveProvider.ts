/**
 * resolveProvider("provider/model") helper (LOU-F8)
 *
 * Parses a "<provider>/<model>" spec string (e.g. "openai/gpt-4o",
 * "anthropic/claude-sonnet-4-5"), looks up that provider's
 * credential/config env var, and delegates to the real
 * `LLMProviderRegistry.create()` (the same registry OpenAIProvider,
 * AnthropicProvider, OllamaProvider and OpenRouterProvider register
 * themselves into - see providers/index.ts) to construct the provider
 * instance, pre-configured with `defaultModel` set to the parsed model.
 * The parsing, env table and error messages live in ./providerSpec (LOU-D1).
 */

import { LLMProviderRegistry, type LLMProvider } from './llm';
import { resolveProviderSpec } from './providerSpec';

/**
 * Resolve a "<provider>/<model>" spec into a configured LLMProvider
 * instance, reading the provider's credential from its conventional env var
 * (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, or
 * `OLLAMA_BASE_URL`). Most callers can skip this and pass the string to
 * `createAgent({ model })` instead.
 *
 * Throws an actionable error for a malformed spec, an unrecognized provider
 * prefix (listing the supported ones and suggesting the closest), a missing
 * API key, or a missing optional peer dependency (with the exact
 * `npm install` command). Spec and prefix are checked BEFORE any call into
 * LLMProviderRegistry, so a bad prefix never reaches the registry.
 *
 * @example
 * const provider = resolveProvider('openai/gpt-4o-mini');
 */
export function resolveProvider(spec: string): LLMProvider {
  return resolveProviderSpec(spec, 'resolveProvider', LLMProviderRegistry);
}
