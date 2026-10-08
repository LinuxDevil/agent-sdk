// Repro: does a reasoning model's thinking leak into result.object / result.text, and is it surfaced
// as result.reasoning / reasoning.* stream events when talking to LM Studio over /v1/responses?
import { createAgent, fromAiSdk } from '@lousho/build-ai-agent';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { localProvider, LOCAL_MODEL, LOCAL_BASE_URL } from '../../_shared/local.js';

const out = z.object({ vendor: z.string(), total: z.string().describe('decimal string') });
const prompt = 'Invoice from Foo Ltd. Items: 2 x 10.00, 1 x 5.50. Tax 10%. What is the total? Think carefully.';

for (const [label, provider] of [
  ['OpenAIProvider (/responses)', localProvider()],
  ['fromAiSdk(openai.chat) (/chat/completions)', fromAiSdk(createOpenAI({ apiKey: 'lm-studio', baseURL: LOCAL_BASE_URL }).chat(LOCAL_MODEL))],
] as const) {
  const agent = createAgent({ provider, output: out });
  const run = agent.stream(prompt);
  const counts: Record<string, number> = {};
  let reasoningChars = 0;
  for await (const ev of run as AsyncIterable<any>) {
    counts[ev.type] = (counts[ev.type] ?? 0) + 1;
    if (ev.type === 'reasoning.delta') reasoningChars += ev.text.length;
  }
  const r = await run.result;
  console.log(`\n[${label}] finish=${r.finishReason} object=${JSON.stringify(r.object)}`);
  console.log('  text startsWith "{":', r.text.trim().startsWith('{'), 'len', r.text.length);
  console.log('  result.reasoning:', r.reasoning === undefined ? 'undefined' : `${r.reasoning.length} chars: ${JSON.stringify(r.reasoning.slice(0, 120))}`);
  console.log('  usage.reasoningTokens:', r.usage.reasoningTokens, ' streamed reasoning chars:', reasoningChars);
  console.log('  event counts:', JSON.stringify(counts));
}
