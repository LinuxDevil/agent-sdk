// Live: how LM Studio (strict json_schema over /v1/responses) treats zod-4 shapes the SDK emits,
// and what the repair step does when a refinement the JSON Schema cannot express fails.
import { createAgent } from '@lousho/build-ai-agent';
import { z } from 'zod';
import { startProxy } from './proxy.js';
import { LOCAL_MODEL } from '../../_shared/local.js';
import { OpenAIProvider } from '@lousho/build-ai-agent';

const proxy = await startProxy(1240, { keepResponses: true });
const provider = new OpenAIProvider({ apiKey: 'lm-studio', baseURL: proxy.url, defaultModel: LOCAL_MODEL });
const which = process.argv[2] ?? 'all';

async function run(name: string, schema: any, prompt: string, extra: Record<string, unknown> = {}) {
  if (which !== 'all' && which !== name) return;
  const before = proxy.log.length;
  const t0 = Date.now();
  try {
    const r = await createAgent({ provider, output: schema, instructions: 'You extract data.', ...extra }).send(prompt);
    console.log(`\n== ${name} (${Date.now() - t0}ms) finish=${r.finishReason} steps=${r.steps} object=${JSON.stringify(r.object)}`);
    if (r.outputError) console.log('   outputError:', JSON.stringify(r.outputError));
    console.log('   text:', JSON.stringify(r.text).slice(0, 300));
    const msgs = r.messages.filter((m: any) => m.role === 'user').map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 200));
    console.log('   user msgs:', msgs);
  } catch (e: any) {
    console.log(`\n== ${name} THREW ${e?.constructor?.name} code=${e?.code}: ${String(e?.message).slice(0, 400)}`);
  }
  for (const e of proxy.log.slice(before)) console.log('   wire', e.path, e.status, e.status !== 200 ? e.responseText?.slice(0, 300) : '');
}

await run('rootUnion', z.discriminatedUnion('kind', [z.object({ kind: z.literal('invoice'), total: z.number() }), z.object({ kind: z.literal('other'), reason: z.string() })]),
  'Document: "Dear Sir, thank you for your letter." Classify it.');
await run('optional', z.object({ vendor: z.string(), poNumber: z.string().optional() }), 'Invoice from Foo Ltd. No PO number.');
// a refinement JSON Schema cannot carry: the model cannot know it, so repair must fail
await run('refineFails', z.object({ subtotal: z.number(), tax: z.number(), total: z.number() }).refine((v) => Math.abs(v.subtotal + v.tax - v.total) < 0.01, { message: 'total must equal subtotal + tax', path: ['total'] }),
  'Invoice: subtotal 100.00, tax 19.00, TOTAL 120.00 (copy the numbers exactly as printed).');
await run('noRepairBudget', z.object({ subtotal: z.number(), tax: z.number(), total: z.number() }).refine((v) => Math.abs(v.subtotal + v.tax - v.total) < 0.01, { message: 'total must equal subtotal + tax', path: ['total'] }),
  'Invoice: subtotal 100.00, tax 19.00, TOTAL 120.00 (copy the numbers exactly as printed).', { maxSteps: 1 });
await run('tinyMaxTokens', z.object({ vendor: z.string() }), 'Invoice from Foo Ltd.', { maxTokens: 40 });
proxy.close();
