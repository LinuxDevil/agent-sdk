// P15 (live): common zod refinements under OpenAI strict structured outputs (gpt-4o-mini via OpenRouter).
// Run: npx tsx eve/providers/p15-strict-keywords.ts
import { z } from 'zod';
import { createAgent } from '@lousho/build-ai-agent';
import '../../_shared/env.ts';
const cases: Record<string, any> = {
  'z.string().default()': z.object({ lang: z.string().default('en') }),
  'z.array().max(3)': z.object({ tags: z.array(z.string()).max(3) }),
  'z.tuple()': z.object({ point: z.tuple([z.number(), z.number()]) }),
  'z.number().int().min(1).max(5)': z.object({ stars: z.number().int().min(1).max(5) }),
  'z.lazy recursive': (() => { const Node: any = z.object({ name: z.string(), children: z.array(z.lazy(() => Node)) }); return z.object({ tree: Node }); })(),
};
for (const [label, schema] of Object.entries(cases)) {
  try {
    const r: any = await createAgent({ model: 'openrouter/openai/gpt-4o-mini', output: schema, retry: false, modelSettings: { maxTokens: 120 } }).send('Give any valid example.');
    console.log(JSON.stringify({ label, finish: r.finishReason, object: r.object }));
  } catch (e: any) {
    console.log(JSON.stringify({ label, THREW: e.code, msg: String(e.message).slice(0, 200) }));
  }
}
