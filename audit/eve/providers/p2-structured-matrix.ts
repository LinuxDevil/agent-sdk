// P2 (live, OpenRouter): `output` schemas across vendors + what usage/cost the run reports.
// ~4 models x 4 schemas, tiny prompts. Run: npx tsx eve/providers/p2-structured-matrix.ts
import { z } from 'zod';
import { createAgent } from '@lousho/build-ai-agent';
import { hasLiveKey } from '../../_shared/env.ts';

if (!hasLiveKey) throw new Error('needs OPENROUTER_API_KEY');

const MODELS = (process.env.P2_MODELS ?? 'openai/gpt-4o-mini,anthropic/claude-haiku-4.5,google/gemini-2.5-flash,meta-llama/llama-3.3-70b-instruct').split(',');

const SCHEMAS: Record<string, { schema: any; prompt: string }> = {
  simple: { schema: z.object({ city: z.string(), tempC: z.number() }), prompt: 'Paris is 21 degrees C today. Report it.' },
  nested: {
    schema: z.object({
      title: z.string(),
      priority: z.enum(['low', 'medium', 'high']),
      assignee: z.string().optional(),
      steps: z.array(z.object({ n: z.number().int(), text: z.string() })).min(1),
    }),
    prompt: 'Bug: app crashes on login after update. Steps: open app, tap login. Triage it.',
  },
  record: {
    schema: z.object({ counts: z.record(z.string(), z.number()) }),
    prompt: 'Count each word in: "a b a c". Use the word as the key.',
  },
  union: {
    schema: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('refund'), amount: z.number() }),
      z.object({ kind: z.literal('question'), text: z.string() }),
    ]),
    prompt: 'Customer: "I want my $20 back for the broken mug."',
  },
};

const only = process.env.P2_SCHEMAS?.split(',');
for (const model of MODELS) {
  for (const [name, { schema, prompt }] of Object.entries(SCHEMAS)) {
    if (only && !only.includes(name)) continue;
    const agent = createAgent({ model: `openrouter/${model}`, output: schema, retry: false, modelSettings: { maxTokens: 400 } });
    const t0 = Date.now();
    try {
      const r: any = await agent.send(prompt);
      console.log(
        JSON.stringify({
          model, name, ms: Date.now() - t0, finish: r.finishReason, repaired: r.outputRepaired ?? false,
          object: r.object, outputError: r.outputError?.message?.slice(0, 160),
          calls: r.usage.modelCalls, in: r.usage.inputTokens, out: r.usage.outputTokens, costUsd: r.usage.costUsd,
          text: r.object ? undefined : String(r.text).slice(0, 160),
        }),
      );
    } catch (e: any) {
      console.log(JSON.stringify({ model, name, THREW: e.code ?? e.name, msg: String(e.message).slice(0, 300) }));
    }
  }
}
