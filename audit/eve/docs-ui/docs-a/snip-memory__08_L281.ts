// memory.md:281
import { inMemoryVectorMemory } from '@lousho/build-ai-agent';
import { hashEmbedder } from '@lousho/build-ai-agent/testing';

const memory = inMemoryVectorMemory({ embedder: hashEmbedder() });
await memory.add('global', { text: 'Sam is vegetarian' });
await memory.add('global', { text: 'The office is in Oslo' });

const [best] = await memory.list('global', { query: 'vegetarian food' });
console.log(best.text, best.metadata?.score); // Sam is vegetarian, a score of about 0.5
export {};
