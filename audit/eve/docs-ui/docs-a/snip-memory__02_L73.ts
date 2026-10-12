// memory.md:73
import { createAgent, defineMemory, inMemoryMemory } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const userFacts = defineMemory({
  name: 'user_facts',
  scope: ({ metadata }) => (typeof metadata?.userId === 'string' ? `user:${metadata.userId}` : undefined),
  provider: inMemoryMemory(),
});

const agent = createAgent({ provider: mockModel(['Hello!']), memory: [userFacts] });
await agent.send('Hi again!', { metadata: { userId: 'u-42' } });
export {};
