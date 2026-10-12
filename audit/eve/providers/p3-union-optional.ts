// P3 (live): root z.union (documented as supported), nested discriminatedUnion,
// and the optional->nullable rewrite on Gemini. Run: npx tsx eve/providers/p3-union-optional.ts
import { z } from 'zod';
import { createAgent } from '@lousho/build-ai-agent';
import { hasLiveKey } from '../../_shared/env.ts';
if (!hasLiveKey) throw new Error('needs OPENROUTER_API_KEY');

async function run(model: string, label: string, schema: any, prompt: string) {
  const agent = createAgent({ model: `openrouter/${model}`, output: schema, retry: false, modelSettings: { maxTokens: 300 } });
  try {
    const r: any = await agent.send(prompt);
    console.log(JSON.stringify({ model, label, finish: r.finishReason, object: r.object, text: String(r.text).slice(0, 200) }));
  } catch (e: any) {
    console.log(JSON.stringify({ model, label, THREW: e.code, msg: String(e.message).slice(0, 220) }));
  }
}

const rootUnion = z.union([z.object({ refund: z.number() }), z.object({ question: z.string() })]);
const nestedDU = z.object({
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('refund'), amount: z.number() }),
    z.object({ kind: z.literal('question'), text: z.string() }),
  ]),
});
for (const m of ['openai/gpt-4o-mini', 'anthropic/claude-haiku-4.5']) {
  await run(m, 'root z.union', rootUnion, 'Customer: "I want my $20 back."');
  await run(m, 'nested discriminatedUnion', nestedDU, 'Customer: "I want my $20 back."');
}

// optional fields on Gemini: does "null" (the string) leak into result.object?
const opt = z.object({ title: z.string(), assignee: z.string().optional(), dueDate: z.string().optional() });
for (let i = 0; i < 3; i++) {
  await run('google/gemini-2.5-flash', `optional #${i + 1}`, opt, 'Ticket: "Login crashes". Nobody is assigned and there is no due date.');
}
