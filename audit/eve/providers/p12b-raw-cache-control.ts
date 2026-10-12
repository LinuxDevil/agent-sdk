// P12b (live, 2 raw calls): the same prompt as P12 WITH an Anthropic cache_control breakpoint,
// sent directly to OpenRouter - what the SDK cannot express. Run: npx tsx eve/providers/p12b-raw-cache-control.ts
import '../../_shared/env.ts';
const rules = Array.from({ length: 260 }, (_, i) => `Rule ${i + 1}: when a customer mentions order ${1000 + i}, respond politely and cite policy section ${i % 17}.`).join('\n');
for (const attempt of [1, 2]) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'anthropic/claude-haiku-4.5', max_tokens: 5,
      messages: [
        { role: 'system', content: [{ type: 'text', text: `You are a support bot.\n${rules}`, cache_control: { type: 'ephemeral' } }] },
        { role: 'user', content: 'Say ok.' },
      ],
    }),
  });
  const j: any = await r.json();
  console.log(JSON.stringify({ attempt, prompt: j.usage?.prompt_tokens, cached: j.usage?.prompt_tokens_details?.cached_tokens, cacheWrite: j.usage?.prompt_tokens_details?.cache_write_tokens, cost: j.usage?.cost }));
}
