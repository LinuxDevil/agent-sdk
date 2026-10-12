// CORE: live - the maxSteps forced-answer call drops `tools` while the history holds
// tool_use/tool_result blocks. Does that survive Anthropic-family models?
// Run: npx tsx eve/core/r3-live-forced-anthropic.ts
import { z } from 'zod';
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { hasLiveKey, LIVE_MODEL } from '../../_shared/env.ts';

if (!hasLiveKey) throw new Error('no key');
const lookup = defineTool({
  name: 'lookup',
  description: 'Look up a fact about a city. Always call this before answering.',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, population: 2_100_000 }),
});

for (const model of [LIVE_MODEL, 'openrouter/anthropic/claude-haiku-4.5']) {
  const agent = createAgent({
    model,
    instructions: 'Always call lookup first, then answer.',
    tools: [lookup],
    maxSteps: 1,
    output: z.object({ city: z.string(), population: z.number() }),
    modelSettings: { maxTokens: 200 },
  });
  try {
    const r = await agent.send('Population of Paris?');
    console.log(`${model}: finishReason=${r.finishReason} object=${JSON.stringify(r.object)} outputError=${r.outputError?.message ?? '-'} steps=${r.steps} calls=${r.stepUsage?.length}`);
  } catch (e: any) {
    console.log(`${model}: THREW ${e.name} ${e.code} :: ${String(e.message).slice(0, 300)}`);
  }
}
