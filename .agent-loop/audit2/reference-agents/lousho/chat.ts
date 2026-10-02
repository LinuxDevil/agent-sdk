// (a) Tool-using chat agent: one zod tool, streaming to stdout.
// Run: OPENAI_API_KEY=... npx tsx chat.ts "Weather in Paris?"
import { z } from 'zod';
import { createAgent, defineTool } from '@lousho/build-ai-agent';

const getWeather = defineTool({
  name: 'get_weather',
  description: 'Return mock weather data for a city.',
  input: z.object({ city: z.string().min(1) }),
  execute: async ({ city }) => ({ city, condition: 'Sunny', temperatureF: 72 }),
});

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  instructions: 'You are a concise weather assistant. Say the data is mocked.',
  tools: [getWeather],
});

for await (const event of agent.stream(process.argv[2] ?? 'What is the weather in Paris?')) {
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
process.stdout.write('\n');
