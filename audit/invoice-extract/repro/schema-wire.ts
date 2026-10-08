// Repro: what JSON Schema does createAgent({ output }) send for zod 4 features? No model needed:
// a capturing provider records GenerateOptions.responseFormat and the system prompt.
import { createAgent, type LLMProvider } from '@lousho/build-ai-agent';
import { z } from 'zod';
import { Extraction } from '../schema.js';

function capture(reply: string) {
  const calls: any[] = [];
  const p: LLMProvider = {
    name: 'capture', defaultModel: 'm',
    async generate(o: any) { calls.push(o); return { text: reply, finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } as any; },
    async stream() { throw new Error('no'); },
    supportsTools: () => true, supportsStreaming: () => false, getModels: async () => ['m'],
  };
  return { p, calls };
}

const cases: Record<string, z.ZodType> = {
  invoiceSchema: Extraction,
  rootDiscriminatedUnion: z.discriminatedUnion('k', [z.object({ k: z.literal('a') }), z.object({ k: z.literal('b'), n: z.number() })]),
  zDate: z.object({ d: z.date() }),
  zCoerceDate: z.object({ d: z.coerce.date() }),
  transform: z.object({ amount: z.string().transform((s) => Number(s)) }),
  optionalField: z.object({ a: z.string(), b: z.string().optional() }),
  defaulted: z.object({ a: z.string().default('x') }),
};

for (const [name, schema] of Object.entries(cases)) {
  const { p, calls } = capture('{}');
  const agent = createAgent({ provider: p, output: schema as any, maxSteps: 1 });
  const r = await agent.send('x');
  const rf = calls[0]?.responseFormat;
  console.log(`\n== ${name}: finish=${r.finishReason} issues=${JSON.stringify(r.outputError?.issues)}`);
  console.log(JSON.stringify(rf?.schema).slice(0, name === 'invoiceSchema' ? 4000 : 600));
}

// z.date(): even a perfect ISO string can never validate
{
  const { p } = capture('{"d":"2026-01-31"}');
  const r = await createAgent({ provider: p, output: z.object({ d: z.date() }), maxSteps: 3 }).send('x');
  console.log('\n== z.date() with a perfect ISO reply:', r.finishReason, JSON.stringify(r.outputError));
}
{
  const { p } = capture('{"d":"2026-01-31"}');
  const r = await createAgent({ provider: p, output: z.object({ d: z.coerce.date() }), maxSteps: 3 }).send('x');
  console.log('== z.coerce.date() with ISO reply:', r.finishReason, r.object, r.object?.d instanceof Date);
}
