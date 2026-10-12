// CORE: live - does adding an onEvent listener (which switches send() to streaming, M9) change usage/cost accuracy?
// Run: npx tsx eve/core/r14-live-onevent-usage.ts
import { createAgent } from '@lousho/build-ai-agent';
import { LIVE_MODEL } from '../../_shared/env.ts';
for (const withListener of [false, true]) {
  const agent = createAgent({ model: LIVE_MODEL, modelSettings: { maxTokens: 30, temperature: 0 }, ...(withListener && { onEvent: () => {} }) });
  const r = await agent.send('Count from 1 to 5.');
  console.log('onEvent=%s -> usage in/out=%d/%d estimated=%s cost=%s', withListener, r.usage.inputTokens, r.usage.outputTokens, r.usage.estimated, r.usage.costUsd);
  const s = agent.stream('Count from 1 to 5.');
  for await (const _ of s) { /* drain */ }
  const sr = await s.result;
  console.log('   stream() -> usage in/out=%d/%d estimated=%s', sr.usage.inputTokens, sr.usage.outputTokens, sr.usage.estimated);
}
