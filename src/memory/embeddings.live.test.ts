/**
 * Live test (costs money, needs OPENROUTER_API_KEY; at most 0.02 USD): `aiSdkEmbedder()` over OpenRouter's
 * embeddings endpoint (`openai/text-embedding-3-small`, through `@ai-sdk/openai` with a custom base URL) feeds
 * `inMemoryVectorMemory`, and a paraphrased query ranks the right item first (N15). Run with
 * `npm run test:live -- src/memory`. No cassette: cassettes record chat providers only.
 */
import { createOpenAI } from '@ai-sdk/openai';
import { describe, expect, it } from 'vitest';
import { aiSdkEmbedder } from './embeddings';
import { inMemoryVectorMemory } from './vectorProvider';

describe.skipIf(!process.env.OPENROUTER_API_KEY)('aiSdkEmbedder through OpenRouter (live, N15)', () => {
  it('ranks the right fact first for a paraphrased query', async () => {
    const openrouter = createOpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY });
    const embedder = aiSdkEmbedder(openrouter.embedding('openai/text-embedding-3-small'), { id: 'openrouter:text-embedding-3-small' });
    const memory = inMemoryVectorMemory({ embedder, minScore: 0 });
    for (const text of ['Sam does not eat meat or fish', 'The head office is located in Oslo', 'The user likes the dark colour theme']) {
      await memory.add('k', { text });
    }

    const found = await memory.list('k', { query: 'Which dietary restrictions does Sam have?' });

    expect(found[0].text).toBe('Sam does not eat meat or fish');
    expect(found[0].metadata?.score).toBeGreaterThan(found[1].metadata?.score as number);
  });
});
