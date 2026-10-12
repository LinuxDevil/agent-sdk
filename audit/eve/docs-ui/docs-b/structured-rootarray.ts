import { z } from 'zod';
import { createAgent } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
for (const [name, schema, reply] of [
  ['array', z.array(z.object({ a: z.string() })), '[{"a":"x"}]'],
  ['string', z.string(), '"hello"'],
  ['record', z.record(z.string(), z.number()), '{"a":1}'],
] as const) {
  try {
    const m = mockModel([reply, reply]);
    const r = await createAgent({ provider: m, output: schema as any }).send('x');
    console.log(name, JSON.stringify({ fr: r.finishReason, obj: r.object, calls: m.calls.length, err: r.outputError?.message, rfType: (m.calls[0].responseFormat as any)?.schema?.type }));
  } catch (e: any) { console.log(name, 'THROW', e.name, e.message.slice(0, 150)); }
}
