// providers.md:12
import { resolveProvider, LLMProviderRegistry } from '@lousho/build-ai-agent';

// The convenient way — reads the credential from the environment
const openai = resolveProvider('openai/gpt-4o-mini');       // OPENAI_API_KEY
const anthropic = resolveProvider('anthropic/claude-sonnet-5-5'); // ANTHROPIC_API_KEY
const openrouter = resolveProvider('openrouter/openai/gpt-4o-mini'); // OPENROUTER_API_KEY
const ollama = resolveProvider('ollama/llama3.1');           // OLLAMA_BASE_URL
// pi runs one catalog through `pi/<pi-provider>/<model>` (nested slashes ok):
const pi = resolveProvider('pi/openrouter/openai/gpt-4o-mini');    // OPENROUTER_API_KEY

// Or construct a provider directly via the registry
const custom = LLMProviderRegistry.create('openai', {
  apiKey: process.env.OPENAI_API_KEY,
  defaultModel: 'gpt-4o-mini',
});
export {};
