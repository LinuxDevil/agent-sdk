// P10 (live, ~4 calls + body capture): reasoning option -> wire + reported reasoning tokens.
// Run: npx tsx eve/providers/p10-reasoning.ts
import { createAgent, OpenRouterProvider } from '@lousho/build-ai-agent';
const captured: any[] = [];
const capture: typeof fetch = async (_u, init) => { captured.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 }); };
import { hasLiveKey } from '../../_shared/env.ts';
if (!hasLiveKey) throw new Error('needs OPENROUTER_API_KEY');

for (const model of ['anthropic/claude-haiku-4.5', 'openai/gpt-oss-120b', 'deepseek/deepseek-v3.1-terminus']) {
  const sent: any[] = [];
  const spy: typeof fetch = async (u, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return fetch(u, init);
  };
  const agent = createAgent({
    provider: new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY!, defaultModel: model, fetch: spy }),
    reasoning: 'low',
    retry: false,
    modelSettings: { maxTokens: 3000 },
  });
  try {
    const r: any = await agent.send('Is 221 prime? Answer yes or no.');
    console.log(JSON.stringify({
      model, reasoningSent: sent[0]?.reasoning ?? null, text: r.text.slice(0, 40),
      reasoningTokens: r.usage.reasoningTokens, reasoningChars: (r.reasoning ?? '').length, out: r.usage.outputTokens, costUsd: r.usage.costUsd,
    }));
  } catch (e: any) {
    console.log(JSON.stringify({ model, reasoningSent: sent[0]?.reasoning ?? null, THREW: e.code, msg: String(e.message).slice(0, 160) }));
  }
}

// claude-fable-5.1 (the registry's own flagship id is claude-fable-5-1): capture only, no live spend.
for (const [label, provider] of [
  ['openrouter anthropic/claude-fable-5.1', () => new OpenRouterProvider({ apiKey: 'k', defaultModel: 'anthropic/claude-fable-5.1', fetch: capture })],
] as const) {
  captured.length = 0;
  try { await createAgent({ provider: provider(), reasoning: 'high', retry: false }).send('x'); } catch {}
  console.log(JSON.stringify({ label, reasoningSent: captured[0]?.reasoning ?? null }));
}
