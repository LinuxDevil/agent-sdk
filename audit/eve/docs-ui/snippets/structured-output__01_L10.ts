// structured-output.md:10
import { z } from 'zod';
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  instructions: 'You report the weather.',
  output: z.object({ city: z.string(), tempC: z.number(), summary: z.string() }),
});

const result = await agent.send('Weather in Paris?');
if (result.object) {
  console.log(result.object.tempC); // typed: number
} else {
  console.error(result.finishReason, result.outputError?.issues); // 'output-invalid', [{ path, message }]
}
export {};
