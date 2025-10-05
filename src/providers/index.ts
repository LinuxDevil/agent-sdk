/**
 * Providers Module
 * LLM provider abstraction and implementations
 */

export * from './llm';
export * from './mock';
export * from './OpenAIProvider';
export * from './OllamaProvider';

// Auto-register built-in providers
import { LLMProviderRegistry } from './llm';
import { OpenAIProvider, OpenAIProviderConfig } from './OpenAIProvider';
import { OllamaProvider, OllamaProviderConfig } from './OllamaProvider';

LLMProviderRegistry.register('openai', (config) => new OpenAIProvider(config as OpenAIProviderConfig));
LLMProviderRegistry.register('ollama', (config) => new OllamaProvider(config as OllamaProviderConfig));
