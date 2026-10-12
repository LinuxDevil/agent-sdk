// memory.md:25
import { createAgent, defineMemory, fileMemory } from '@lousho/build-ai-agent';

const preferences = defineMemory({
  name: 'preferences',
  description: "the user's preferences: language, tone, tools they like",
  scope: 'session',
  provider: fileMemory({ dir: './.lousho/memory' }),
});

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  instructions: 'You are a helpful assistant. Save lasting preferences with remember_preferences.',
  memory: [preferences],
});

await agent.session({ id: 'user-42' }).send('Please always answer in French.');
// Later, in a new conversation with the same id, the preference is in the system prompt:
const { text } = await agent.session({ id: 'user-42' }).send('What is the capital of Japan?');
export {};
