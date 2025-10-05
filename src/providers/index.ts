/**
 * Providers Module
 * LLM provider abstraction and implementations
 */

export * from './llm';
export * from './mock';
export * from './OpenAIProvider';
export * from './OllamaProvider';
export * from './OpenRouterProvider';

// Auto-register built-in providers
import { LLMProviderRegistry } from './llm';
import { OpenAIProvider, OpenAIProviderConfig } from './OpenAIProvider';
import { OllamaProvider, OllamaProviderConfig } from './OllamaProvider';
import { OpenRouterProvider, OpenRouterProviderConfig } from './OpenRouterProvider';

LLMProviderRegistry.register('openai', (config) => new OpenAIProvider(config as OpenAIProviderConfig));
LLMProviderRegistry.register('ollama', (config) => new OllamaProvider(config as OllamaProviderConfig));
LLMProviderRegistry.register('openrouter', (config) => new OpenRouterProvider(config as OpenRouterProviderConfig));
