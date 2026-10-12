// streaming.md:264
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });
const run = agent.stream('Write a long story');

let chars = 0;
for await (const event of run) {
  if (event.type === 'text.delta') chars += event.text.length;
  if (chars > 500) break; // aborts the run
}
console.log((await run.result).finishReason); // 'aborted'
export {};
