// P12 (live, 4 calls, ~$0.02): prompt caching across two identical agent calls with a long system prompt.
// Run: npx tsx eve/providers/p12-prompt-caching.ts
import { createAgent } from '@lousho/build-ai-agent';
import { hasLiveKey } from '../../_shared/env.ts';
if (!hasLiveKey) throw new Error('needs OPENROUTER_API_KEY');

// ~5k tokens of stable instructions (an agent's system prompt + tool schemas are typically this size or larger)
const rules = Array.from({ length: 260 }, (_, i) => `Rule ${i + 1}: when a customer mentions order ${1000 + i}, respond politely and cite policy section ${i % 17}.`).join('\n');

for (const model of ['openai/gpt-4o-mini', 'anthropic/claude-haiku-4.5']) {
  const agent = createAgent({ model: `openrouter/${model}`, instructions: `You are a support bot.\n${rules}`, retry: false, modelSettings: { maxTokens: 5 } });
  for (const attempt of [1, 2]) {
    const r: any = await agent.send('Say ok.');
    console.log(JSON.stringify({ model, attempt, in: r.usage.inputTokens, cachedInputTokens: r.usage.cachedInputTokens ?? null, costUsd: r.usage.costUsd ?? null }));
  }
}
