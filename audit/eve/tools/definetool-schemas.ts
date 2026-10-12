/* TOOLS: defineTool accepts input schemas that cannot work with a model, with no warning:
   - z.date()/z.bigint() fields render as `{}` (the same zod->JSON options the provider uses), and the
     ISO string the model then sends fails validation;
   - a non-object root (z.string()) is accepted; OpenAI-compatible providers reject the whole request.
   Run: npx tsx eve/tools/definetool-schemas.ts   (live part needs OPENROUTER_API_KEY; 1 cheap call) */
import { z, toJSONSchema } from 'zod';
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { hasLiveKey, LIVE_MODEL } from '../../_shared/env';

const sendAs = (s: z.ZodType) => JSON.stringify(toJSONSchema(s, { target: 'draft-7', io: 'input', unrepresentable: 'any' }));

// 1) z.date(): what the model is told, and what happens when it sends the obvious ISO string
const schedule = defineTool({
  name: 'schedule', description: 'Schedule a meeting', input: z.object({ when: z.date(), n: z.bigint() }),
  execute: async ({ when }) => `scheduled ${when.toISOString()}`,
});
console.log('z.date()/z.bigint() fields as sent (src/utils/zodCompat.ts:67 options):', sendAs(schedule.input as any));
const model = mockModel([{ toolCalls: [{ name: 'schedule', args: { when: '2026-10-09T10:00:00Z', n: 1 } }] }, 'done']);
await createAgent({ provider: model, instructions: 'i', tools: [schedule] }).send('book it');
const toolMsg: any = model.calls[1]?.messages.find((m: any) => m.role === 'tool');
console.log('model got back:', JSON.stringify(toolMsg?.content).slice(0, 220));

// 2) non-object root
const shout = defineTool({ name: 'shout', description: 'Shout text', input: z.string() as any, execute: async (s: any) => String(s).toUpperCase() });
console.log('non-object root accepted by defineTool; schema:', sendAs(shout.input as any));
if (hasLiveKey) {
  try {
    const r = await createAgent({ model: LIVE_MODEL, instructions: 'Be brief.', tools: [shout] } as any).send('say hi');
    console.log('live:', r.finishReason, String(r.text).slice(0, 60));
  } catch (e) {
    console.log('live THREW:', String((e as Error).message).slice(0, 220));
  }
}
