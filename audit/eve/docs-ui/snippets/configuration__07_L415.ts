// configuration.md:415
import { createAgent, memoryStore } from '@lousho/build-ai-agent';

const agent = createAgent({ provider, store: memoryStore(), limits: { maxTokens: 20_000 } });
const session = agent.session({ id: 'user-42', limits: { maxCostUsd: 1 } });
const reply = await session.send('Hello');
if (reply.budget?.scope === 'session') console.log('This conversation used up its budget.');
export {};
