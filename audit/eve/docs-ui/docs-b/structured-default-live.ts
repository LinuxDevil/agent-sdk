// docs/structured-output.md "Optional fields": .optional() and .default() are sent as required+nullable for strict endpoints.
import { z } from 'zod';
import { createAgent } from '@lousho/build-ai-agent';
import { LIVE_MODEL, hasLiveKey } from '../../../_shared/env.ts';
if (!hasLiveKey) process.exit(0);
for (const [label, schema] of [
  ['optional', z.object({ verdict: z.string(), note: z.string().optional() })],
  ['default', z.object({ verdict: z.string(), lang: z.string().default('en') })],
  ['nested optional in array', z.object({ items: z.array(z.object({ a: z.string(), b: z.number().optional() })) })],
] as const) {
  try {
    const r = await createAgent({ model: LIVE_MODEL, output: schema as any }).send('Review this change: "fix typo". Keep it short.');
    console.log(label, JSON.stringify({ fr: r.finishReason, obj: r.object, err: r.outputError?.message }).slice(0, 300));
  } catch (e: any) { console.log(label, 'THROW', e.code, String(e.message).slice(0, 250)); }
}
