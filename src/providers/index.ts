/**
 * Providers Module
 * LLM provider abstraction and implementations
 */

export * from './llm';
export { textOf, toolResultText } from './content';
export type { AgentInput } from './content';
export type { ReasoningEffort, ReasoningOption, ReasoningSettings } from './reasoning';
export type { PromptCachingOption } from './promptCaching';
export * from './mock';
export * from './OpenAIProvider';
export * from './OllamaProvider';
export * from './OpenRouterProvider';
export * from './AnthropicProvider';
export { PiProvider, type PiProviderConfig } from './pi/PiProvider';
export * from './resolveProvider';
export * from './resilience';
export * from './rateLimit';
export { fromAiSdk, type FromAiSdkOptions } from './fromAiSdk';
export type { UnsupportedFiles } from './aiSdkProvider';
export { MissingPeerDependencyError } from './optionalPeer';

// Auto-register built-in providers for consumers of this barrel, so
// has()/getProviderNames() reflect them before the first create(). The
// factories only construct provider objects; each provider loads its
// optional peer SDK on first use (LOU-D10, LOU-D19), so this registration
// never loads (or requires) a peer package. Every other entry point (deep
// imports, the `lousho` CLI, deploy bundles) gets the same registrations
// lazily: LLMProviderRegistry.create() calls ensureBuiltinProviders() on a
// miss (LOU-R1).
import { LLMProviderRegistry } from './llm';
import { ensureBuiltinProviders } from './builtinProviders';

ensureBuiltinProviders(LLMProviderRegistry);
