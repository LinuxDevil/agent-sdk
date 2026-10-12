// quick-start.md:266
import { specToAgent, agentSpecSchema } from '@lousho/build-ai-agent';

const spec = agentSpecSchema.parse({
  name: 'support-bot',
  prompt: 'You are a friendly support agent.',
  provider: { type: 'mock', model: 'mock-1' },
  tools: ['current-date'],
});

const agent = specToAgent(spec);
const result = await agent.send('Hello!');
console.log(result.text);
export {};
