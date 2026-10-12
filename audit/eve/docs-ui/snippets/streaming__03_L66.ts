// streaming.md:66
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });

const run = agent.stream('Summarize the report', { signal: AbortSignal.timeout(30_000) });
const result = await run.result; // no iteration needed
console.log(result.finishReason, result.text);
export {};
