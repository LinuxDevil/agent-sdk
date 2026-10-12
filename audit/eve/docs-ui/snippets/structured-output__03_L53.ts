// structured-output.md:53
import { z } from 'zod';
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini', output: z.object({ city: z.string(), tempC: z.number() }) });
const session = agent.session();
const { object } = await session.send('Weather in Paris?');
console.log(object?.tempC); // typed: number
export {};
