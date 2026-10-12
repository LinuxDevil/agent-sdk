// Scratch: does a run on the examples' LIVE_MODEL report a cost (so limits.maxCostUsd can trip)?
import { createAgent } from '../../../../src/createAgent';
const agent = createAgent({ name: 'cost-check', instructions: 'Reply with one word.', model: 'openrouter/openai/gpt-4o-mini', limits: { maxCostUsd: 0.0000001 } } as any);
const r: any = await agent.send('Say hi');
console.log('finishReason:', r.finishReason, '| text:', JSON.stringify(r.text), '| usage:', JSON.stringify(r.usage));
