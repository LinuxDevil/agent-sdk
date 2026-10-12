// configuration.md:222
import { createAgent, resolveProvider, withFallback, withRetry } from '@lousho/build-ai-agent';

const provider = withFallback(
  [
    withRetry(resolveProvider('openai/gpt-4o-mini'), {
      maxRetries: 3,
      backoff: { initialMs: 500, maxMs: 10_000 },
      onRetry: ({ attempt, delayMs }) => console.warn(`retry ${attempt} in ${delayMs}ms`),
    }),
    withRetry(resolveProvider('anthropic/claude-haiku-4-5')),
  ],
  { onFallback: ({ from, to }) => console.warn(`falling back from ${from} to ${to}`) }
);

const agent = createAgent({ prompt: 'You are helpful.', provider });
export {};
