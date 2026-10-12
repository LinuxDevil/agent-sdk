// tools.md:10
import { defineTool, createAgent, type ToolInput, type ToolOutput } from '@lousho/build-ai-agent';
import { z } from 'zod';

const weather = defineTool({
  name: 'weather', // 1-64 chars: letters, digits, _ and -
  description: 'Get weather information',
  input: z.object({ location: z.string(), units: z.enum(['celsius', 'fahrenheit']) }),
  execute: async ({ location, units }) => ({ temperature: 72, conditions: 'sunny' }),
});

type WeatherArgs = ToolInput<typeof weather>;   // { location: string; units: 'celsius' | 'fahrenheit' }
type WeatherResult = ToolOutput<typeof weather>; // { temperature: number; conditions: string }

const agent = createAgent({ prompt: '...', provider, tools: [weather] });
export {};
