// memory.md:112
import { z } from 'zod';
import { defineMemory, inMemoryMemory } from '@lousho/build-ai-agent';

const relationship = defineMemory({
  name: 'relationship',
  scope: 'global',
  provider: inMemoryMemory(),
  itemSchema: z.object({ trust: z.number(), mood: z.string(), insideJokes: z.array(z.string()) }),
});
// remember_relationship now takes { trust, mood, insideJokes }; recall returns e.g. {"insideJokes":[],"mood":"playful","trust":10}
export {};
