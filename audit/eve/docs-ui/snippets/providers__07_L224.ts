// providers.md:224
import { Agent } from 'undici';
import { createAgent, OpenAIProvider } from '@lousho/build-ai-agent';

// Wait up to 15 minutes for the response headers and between body chunks.
const dispatcher = new Agent({ headersTimeout: 15 * 60_000, bodyTimeout: 15 * 60_000 });

const agent = createAgent({
  provider: new OpenAIProvider({
    apiKey: 'lm-studio',
    baseURL: 'http://localhost:1234/v1',
    defaultModel: 'qwen3-32b',
    fetch: (input, init) => fetch(input, { ...init, dispatcher } as RequestInit),
  }),
  retry: { maxRetries: 2 },
});
export {};
