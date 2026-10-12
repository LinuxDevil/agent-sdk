/* Eve multiagent repro 9 (live, ~6-10 cheap calls): gpt-4o-mini driving the task tool.
 * Records every lead tool call and whether it errored. Run: npx tsx eve/multiagent/r9-live-task.ts */
import { LIVE_MODEL, hasLiveKey } from '../../_shared/env.js';
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';
if (!hasLiveKey) { console.log('skip: no key'); process.exit(0); }
const population = defineTool({ name: 'city_population', description: 'Population of a city', input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, population: city.toLowerCase().includes('paris') ? 2_100_000 : 3_600_000 }) });
const researcher = createAgent({ model: LIVE_MODEL, name: 'researcher', instructions: 'Answer using your tool. One sentence.', description: 'Looks up the population of ONE city', tools: [population], maxSteps: 4 });
const events: string[] = [];
const lead = createAgent({
  model: LIVE_MODEL, name: 'lead', maxSteps: 6,
  instructions: 'You coordinate. Use sub-agents for lookups; ask about each city in a separate task, in parallel.',
  subagents: { researcher },
  onEvent: (e: any) => { if (!e.subagent && e.type === 'tool.done') events.push(`${e.toolName}${e.isError || e.error ? ' ERROR ' + JSON.stringify(e.error ?? e.result).slice(0, 160) : ''}`); },
} as any);
const r = await lead.send('Which is bigger, Paris or Berlin? Give both populations.');
console.log('finish:', r.finishReason, '| steps:', r.steps, '| text:', r.text.slice(0, 200));
console.log('lead tool calls:', events);
console.log('usage:', r.usage.inputTokens, 'in /', r.usage.outputTokens, 'out; delegated runs:', r.usage.delegated?.runs, 'cost', r.usage.costUsd);
