// quick-start.md:71
import { createAgent, createMockProvider, defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

const currentDate = defineTool({
  name: 'current_date',
  description: 'Get the current date',
  input: z.object({}),
  async execute() {
    return { date: new Date().toISOString().slice(0, 10) };
  },
});

const agent = createAgent({
  prompt: 'You are a scheduling assistant. Use tools when helpful.',
  provider: createMockProvider({ responses: ['Let me check.', 'Here is the date you asked for.'] }),
  tools: [currentDate],
});

const result = await agent.send('Please call current_date for me');
console.log(result.toolCalls.map((call) => call.function.name)); // [ 'current_date' ]
console.log(result.text);
export {};
