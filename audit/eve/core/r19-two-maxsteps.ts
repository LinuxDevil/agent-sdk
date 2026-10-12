// CORE: `maxSteps` vs `limits.maxSteps` - two knobs, different endings, forced answer only on one.
// Run: npx tsx eve/core/r19-two-maxsteps.ts
import { z } from 'zod';
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
const lookup = defineTool({ name: 'lookup', description: 'l', input: z.object({}), execute: async () => 'data' });
const script = () => mockModel([(req) => (req.tools?.length ? { toolCalls: [{ name: 'lookup' }] } : '{"answer":"from gathered data"}')], { onExhausted: 'repeat-last' });
for (const [label, cfg] of [
  ['maxSteps: 1', { maxSteps: 1 }],
  ['limits: { maxSteps: 1 }', { limits: { maxSteps: 1 } }],
  ['both (maxSteps 5, limits.maxSteps 1)', { maxSteps: 5, limits: { maxSteps: 1 } }],
] as const) {
  const m = script();
  const r = await createAgent({ provider: m, tools: [lookup], output: z.object({ answer: z.string() }), ...(cfg as any) }).send('go');
  console.log('%s -> finishReason=%s object=%j budget=%j modelCalls=%d', label.padEnd(38), r.finishReason, r.object, r.budget?.limit, m.calls.length);
}
