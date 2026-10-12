// structured-output.md:105
import { z } from 'zod';
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openrouter/openai/gpt-4o-mini',
  output: z.object({ verdict: z.string(), note: z.string().optional() }),
});
const { object } = await agent.send('Review this change.');
// The model may answer {"verdict":"approve","note":null}; object is { verdict: 'approve' }.
console.log(object?.note); // typed: string | undefined
export {};
