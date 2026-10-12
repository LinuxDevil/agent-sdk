// configuration.md:183
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  retry: { maxRetries: 3, backoff: { initialMs: 1000 } }, // default { maxRetries: 2 }; false turns it off
  fallbackModels: ['anthropic/claude-haiku-4-5'], // tried in order once the retries are used up
});

for await (const event of agent.stream('Hello!')) {
  if (event.type === 'provider.retry') console.warn(`retry ${event.attempt} in ${event.delayMs}ms: ${event.error.message}`);
  if (event.type === 'provider.fallback') console.warn(`falling back from ${event.from} to ${event.to}`);
}
export {};
