// quick-start.md:243
import { createAgent, createMockProvider, resolveProvider } from '@lousho/build-ai-agent';

const provider = process.env.OPENAI_API_KEY
  ? resolveProvider('openai/gpt-4o-mini')
  : createMockProvider({ responses: ['Paris.'] });

const agent = createAgent({
  name: 'geography-bot',
  prompt: 'Answer geography questions in one word.',
  provider,
});

const result = await agent.send('What is the capital of France?');
console.log(result.text);
export {};
