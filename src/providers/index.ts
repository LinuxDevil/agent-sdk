/**
 * Providers Module
 * LLM provider abstraction and implementations
 */

export * from './llm';
export { textOf } from './content';
export type { AgentInput } from './content';
export * from './mock';
export * from './OpenAIProvider';
export * from './OllamaProvider';
export * from './OpenRouterProvider';
export * from './AnthropicProvider';
export * from './resolveProvider';
export * from './resilience';
export { MissingPeerDependencyError } from './optionalPeer';

// Auto-register built-in providers. The factories only construct provider
// objects; each provider loads its optional peer SDK on first use (LOU-D10,
// LOU-D19), so this registration never loads (or requires) a peer package.
import { LLMProviderRegistry } from './llm';
import { OpenAIProvider, OpenAIProviderConfig } from './OpenAIProvider';
import { OllamaProvider, OllamaProviderConfig } from './OllamaProvider';
import { OpenRouterProvider, OpenRouterProviderConfig } from './OpenRouterProvider';
import { AnthropicProvider, AnthropicProviderConfig } from './AnthropicProvider';
import { MockLLMProvider, MockProviderConfig } from './mock';

LLMProviderRegistry.register('openai', (config) => new OpenAIProvider(config as OpenAIProviderConfig));
LLMProviderRegistry.register('ollama', (config) => new OllamaProvider(config as OllamaProviderConfig));
LLMProviderRegistry.register('openrouter', (config) => new OpenRouterProvider(config as OpenRouterProviderConfig));
LLMProviderRegistry.register('anthropic', (config) => new AnthropicProvider(config as AnthropicProviderConfig));
// Zero-config/dev-server support (LOU-H): registered centrally so `loushy dev`
// and starter templates can resolve 'mock' outside of the test suite, where
// individual test files previously registered it themselves. Registration
// here is safe even though some tests also register 'mock' in beforeAll/
// beforeEach - LLMProviderRegistry.register() just does a Map.set(), so a
// later registration silently overwrites rather than throwing.
LLMProviderRegistry.register('mock', (config) => new MockLLMProvider(config as MockProviderConfig));
