// P11 (offline): model-string resolution edge cases.
// Run: npx tsx eve/providers/p11-spec-resolution.ts
import { createAgent, LLMProviderRegistry, OpenAIProvider, resolveProvider } from '@lousho/build-ai-agent';
import { report } from '../../_shared/env.ts';

// 1. a provider registered through the documented registry cannot be named in a model string
LLMProviderRegistry.register('groq', (cfg) => new OpenAIProvider({ apiKey: 'k', baseURL: 'https://api.groq.com/openai/v1', api: 'chat', ...cfg } as any));
console.log('registry has groq:', LLMProviderRegistry.has('groq'));
try {
  createAgent({ model: 'groq/llama-3.3-70b-versatile' });
  report('registered provider usable as model string', true, '');
} catch (e: any) {
  report('registered provider usable as model string', false, `${e.code}: ${e.message.slice(0, 140)}`);
}

// 2. env default for anthropic: src/providers/providerSpec.ts:151 envDefaultModel 'claude-3-5-sonnet-latest'
const { AnthropicProvider, OpenRouterProvider } = await import('@lousho/build-ai-agent');
console.log('fallback models (no defaultModel):', {
  openai: new OpenAIProvider({ apiKey: 'k' }).defaultModel,
  anthropic: new AnthropicProvider({ apiKey: 'k' }).defaultModel,
  openrouter: new OpenRouterProvider({ apiKey: 'k' }).defaultModel,
});
console.log('supportsTools:', ['gpt-5', 'o3', 'o4-mini', 'gpt-4.1'].map((m) => `${m}=${new OpenAIProvider({ apiKey: 'k' }).supportsTools(m)}`).join(' '));
console.log('getModels (anthropic):', await new AnthropicProvider({ apiKey: 'k' }).getModels());
