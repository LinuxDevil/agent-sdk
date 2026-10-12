// P5 (live, 1 call): what OpenRouter's own response carries that the SDK drops (usage.cost, cache details).
// Run: npx tsx eve/providers/p5-openrouter-raw-usage.ts
import '../../_shared/env.ts';
const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'anthropic/claude-haiku-4.5', messages: [{ role: 'user', content: 'Say hi' }], max_tokens: 10 }),
});
const j: any = await r.json();
console.log('status', r.status, 'usage:', JSON.stringify(j.usage));
