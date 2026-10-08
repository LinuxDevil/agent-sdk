/**
 * C2: the built-in providers' `fetch` option, and one retry layer: a
 * provider instance wrapped by createAgent's `retry` sends each attempt once
 * (the 'ai' SDK's own retries are off), and `retry: false` sends one request.
 * No network: every request goes to the configured `fetch`.
 */
import { describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from './OpenAIProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import { OllamaProvider } from './OllamaProvider';
import type { LLMProvider } from './llm';
import { createAgent } from '../createAgent';

/** A `fetch` that answers every request with a 500. */
function failingFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ error: { message: 'engine crashed' } }), { status: 500 }));
}

const providers: Array<[string, (fetch: typeof globalThis.fetch) => LLMProvider]> = [
  ['openai', (fetch) => new OpenAIProvider({ apiKey: 'k', fetch, maxRetries: 0 })],
  ['anthropic', (fetch) => new AnthropicProvider({ apiKey: 'k', fetch, maxRetries: 0 })],
  ['openrouter', (fetch) => new OpenRouterProvider({ apiKey: 'k', fetch, maxRetries: 0 })],
  ['ollama', (fetch) => new OllamaProvider({ fetch, maxRetries: 0 })],
];

describe('provider `fetch` option (C2)', () => {
  it.each(providers)('%s sends its model calls through the configured fetch', async (_name, create) => {
    const fetch = failingFetch();
    await expect(create(fetch).generate({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('one retry layer for a provider instance (C2)', () => {
  const fast = { backoff: { initialMs: 1, jitter: false } };

  it('retry: false sends one request, not the ai SDK default of 3', async () => {
    const fetch = failingFetch();
    const agent = createAgent({ provider: new OpenAIProvider({ apiKey: 'k', fetch }), instructions: 'x', retry: false });
    await agent.send('hi').catch(() => undefined);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('an explicit retry is the only layer: maxRetries 2 sends 3 requests, not 9', async () => {
    const fetch = failingFetch();
    const agent = createAgent({ provider: new OpenAIProvider({ apiKey: 'k', fetch }), instructions: 'x', retry: { ...fast, maxRetries: 2 } });
    await agent.send('hi').catch(() => undefined);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
