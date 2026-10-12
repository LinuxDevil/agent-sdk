// streaming.md:282
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

const getWeather = defineTool({
  name: 'get_weather',
  description: 'Current weather for a city',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 21 }),
});

const agent = createAgent({ model: 'openai/gpt-4o-mini', tools: [getWeather] });

for await (const event of agent.stream('Weather in Paris?')) {
  switch (event.type) {
    case 'text.delta':
      process.stdout.write(event.text);
      break;
    case 'tool.start':
      console.log(`\n→ ${event.toolName}(${JSON.stringify(event.args)})`);
      break;
    case 'tool.done':
      console.log(`← ${event.toolName} in ${event.durationMs}ms`);
      break;
    case 'run.done':
      console.log(`\n[${event.finishReason}, ${event.usage?.totalTokens ?? 0} tokens]`);
      break;
  }
}
export {};
