// memory.md:229
import { createAgent, defineMemory, aiSdkEmbedder, inMemoryVectorMemory } from '@lousho/build-ai-agent';
import { createOpenAI } from '@ai-sdk/openai';

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const facts = defineMemory({
  name: 'facts',
  scope: 'global',
  provider: inMemoryVectorMemory({
    embedder: aiSdkEmbedder(openai.embedding('text-embedding-3-small')),
    minScore: 0.3,
  }),
  recall: { query: 'last-input' },
});
const agent = createAgent({ model: 'openai/gpt-4o-mini', memory: [facts] });
export {};
