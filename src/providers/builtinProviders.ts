/**
 * Built-in provider registration (LOU-R1).
 *
 * `LLMProviderRegistry.create()` calls {@link ensureBuiltinProviders} when a
 * lookup misses, so the built-in providers resolve from EVERY import path -
 * a deep `import { createAgent }`, `resolveProvider()`, `specToAgent()`, the
 * `lousho` CLI and generated deploy servers alike - without `src/index.ts`
 * (or this module) having been imported for its side effects first.
 *
 * LOU-D10/LOU-D19 laziness is preserved: importing this module loads only
 * the provider *classes*. Each provider loads its optional peer SDK
 * ('@ai-sdk/openai', '@ai-sdk/anthropic', 'ollama-ai-provider(-v2)') through
 * `loadOptionalPeer()` on the first generate()/stream() call, never at
 * module scope - so nothing here imports (or requires) an optional peer.
 *
 * The import graph is deliberately circular: llm.ts imports this module for
 * `ensureBuiltinProviders`, and this module imports `LLMProviderRegistry`
 * plus the provider classes, which import llm.ts back. The cycle is sound
 * because every cross-reference is deferred - the providers are only
 * constructed inside the factories, `LLMProviderRegistry` is only touched
 * inside `ensureBuiltinProviders()`, and no module in this graph reads
 * llm.ts's bindings at module top level. (That is why mock.ts no longer
 * self-registers at module scope: evaluated through this cycle, a top-level
 * `LLMProviderRegistry.register()` there would run while llm.ts is still
 * being initialized.)
 */

import { LLMProviderRegistry, type ProviderFactory } from './llm';
import { OpenAIProvider, type OpenAIProviderConfig } from './OpenAIProvider';
import { AnthropicProvider, type AnthropicProviderConfig } from './AnthropicProvider';
import { OpenRouterProvider, type OpenRouterProviderConfig } from './OpenRouterProvider';
import { OllamaProvider, type OllamaProviderConfig } from './OllamaProvider';
import { MockLLMProvider, type MockProviderConfig } from './mock';

/** `name -> factory` for every built-in provider (providerSpec.ts's order, plus 'mock'). */
const BUILTIN_FACTORIES: ReadonlyArray<readonly [string, ProviderFactory]> = [
  ['openai', (config) => new OpenAIProvider(config as OpenAIProviderConfig)],
  ['anthropic', (config) => new AnthropicProvider(config as AnthropicProviderConfig)],
  ['openrouter', (config) => new OpenRouterProvider(config as OpenRouterProviderConfig)],
  ['ollama', (config) => new OllamaProvider(config as OllamaProviderConfig)],
  ['mock', (config) => new MockLLMProvider(config as MockProviderConfig)],
];

/**
 * Register every built-in provider that is not already registered.
 * Idempotent and never overwrites: a name a caller (or a test) registered
 * itself keeps its factory, so `register()` always wins over the built-ins.
 */
export function ensureBuiltinProviders(): void {
  for (const [name, factory] of BUILTIN_FACTORIES) {
    if (!LLMProviderRegistry.has(name)) LLMProviderRegistry.register(name, factory);
  }
}
