// structured-output.md:38
import { z } from 'zod/v4';
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini', output: z.object({ city: z.string() }) });
const { object } = await agent.send('Where is the Eiffel Tower?');
console.log(object?.city); // typed: string
export {};
