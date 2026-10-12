// CORE: live - usage/cost shape, modelSettings errors, stream event shape on a real model.
// Run: npx tsx eve/core/r7-live-usage-settings.ts
import { createAgent, formatUsage } from '@lousho/build-ai-agent';
import { hasLiveKey, LIVE_MODEL } from '../../_shared/env.ts';

if (!hasLiveKey) throw new Error('no key');

// A: usage + cost on the default live model
{
  const r = await createAgent({ model: LIVE_MODEL, modelSettings: { maxTokens: 20 } }).send('Say hi in 3 words.');
  console.log('A usage=%j', r.usage);
  console.log('A formatUsage:', formatUsage(r.usage));
  console.log('A stepUsage[0]=%j', r.stepUsage?.[0]);
}

// B: a model the price table does not know (OpenRouter-only id)
{
  const r = await createAgent({ model: 'openrouter/meta-llama/llama-3.1-8b-instruct', modelSettings: { maxTokens: 20 } }).send('Say hi.');
  console.log('B unknown-price model cost=%j totalTokens=%d', r.usage.cost ?? r.usage, r.usage.totalTokens);
}

// C: invalid modelSettings reach the provider unvalidated - what does the user see?
for (const ms of [{ temperature: 5 }, { maxTokens: -1 }, { topP: 7 }]) {
  try {
    const r = await createAgent({ model: LIVE_MODEL, modelSettings: ms as any }).send('hi');
    console.log('C %j -> accepted, finishReason=%s text=%j', ms, r.finishReason, r.text.slice(0, 40));
  } catch (e: any) {
    console.log('C %j -> %s %s :: %s', ms, e.name, e.code, String(e.message).slice(0, 220));
  }
}

// D: a typo'd model id
try {
  await createAgent({ model: 'openrouter/openai/gpt-4o-mni' }).send('hi');
} catch (e: any) {
  console.log('D bad model id -> %s %s :: %s', e.name, e.code, String(e.message).slice(0, 220));
}
