// providers.md:63
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  retry: { maxRetries: 3 }, // or false
  fallbackModels: ['anthropic/claude-haiku-4-5', 'openrouter/meta-llama/llama-3.3-70b-instruct'],
});
export {};
