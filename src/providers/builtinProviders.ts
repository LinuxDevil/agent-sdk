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
 * The import graph is deliberately acyclic (LOU-R27): llm.ts imports this
 * module for `ensureBuiltinProviders`, but this module never imports llm.ts
 * back - the registry arrives as the {@link BuiltinProviderRegistrar}
 * argument instead. The provider classes' own `import type` edges into
 * llm.ts are erased at compile time, so `import { createAgent }` works
 * under true ESM (.mts) as well as through the bundled dist.
 */

import type { ProviderFactory } from './llm';
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
 * The registry surface `ensureBuiltinProviders` writes to. Satisfied by
 * `LLMProviderRegistry` (its `has`/`register` are static, so pass the class
 * itself). Injected rather than imported: importing llm.ts here would
 * re-create the LOU-R1 import cycle fallow flags (LOU-R27).
 */
export interface BuiltinProviderRegistrar {
  has(name: string): boolean;
  register(name: string, factory: ProviderFactory): void;
}

/**
 * Register every built-in provider that is not already registered.
 * Idempotent and never overwrites: a name a caller (or a test) registered
 * itself keeps its factory, so `register()` always wins over the built-ins.
 */
export function ensureBuiltinProviders(registry: BuiltinProviderRegistrar): void {
  for (const [name, factory] of BUILTIN_FACTORIES) {
    if (!registry.has(name)) registry.register(name, factory);
  }
}
