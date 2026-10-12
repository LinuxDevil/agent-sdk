// structured-output.md:80
import { z } from 'zod';
import { createAgent } from '@lousho/build-ai-agent';

const reporter = createAgent({
  model: 'openai/gpt-4o-mini',
  description: 'Reports the weather as { city, tempC }',
  output: z.object({ city: z.string(), tempC: z.number() }),
});
const lead = createAgent({ model: 'openai/gpt-4o-mini', subagents: { reporter } });
const result = await lead.send('What is the weather in Paris?');
console.log(result.text);
export {};
