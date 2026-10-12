// P4 (offline): model registry lookups / estimateCost for the ids people actually pass.
// Compare with OpenRouter's catalog (GET /models, prices per token) captured 2026-10-09.
// Run: npx tsx eve/providers/p4-pricing.ts
import { getModelInfo, estimateCost } from '@lousho/build-ai-agent';

const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
// [model id as passed to the provider, OpenRouter's real $/Mtok in+out for 1M/1M]
const cases: Array<[string, number | null]> = [
  ['openai/gpt-4o-mini', 0.15 + 0.6],
  ['openai/gpt-4o-2024-05-13', 5 + 15],          // dated snapshot with its OWN price
  ['anthropic/claude-haiku-4.5', 1 + 5],          // OpenRouter spells versions with dots
  ['anthropic/claude-haiku-4-5', 1 + 5],
  ['google/gemini-2.5-flash', 0.3 + 2.5],
  ['meta-llama/llama-3.3-70b-instruct', 0.1 + 0.32],
  ['claude-3-5-sonnet-latest', null],             // the SDK's own anthropic default
  ['gpt-4', null],                                // OpenAIProvider fallbackModel
  ['openai/gpt-3.5-turbo', 0.5 + 1.5],            // OpenRouterProvider fallbackModel
  ['mistral-large-2411', null],
  ['mistral-7b-instruct', null],
];
for (const [id, real] of cases) {
  const info = getModelInfo(id);
  const est = estimateCost(usage, id);
  console.log(
    `${id.padEnd(36)} -> registry=${info ? `${info.id} (${info.provider}, ctx ${info.contextWindow})` : 'unknown'}`.padEnd(95),
    `estimate=$${est ?? 'undefined'} real=$${real ?? '?'}`,
  );
}

// cached input tokens are billed at a discount (OpenAI 50%, Anthropic/Gemini 10%) - estimateCost has no input for them
console.log('estimateCost signature accepts cachedInputTokens?', estimateCost.length, '(usage, model) - cache ignored');
const cached = estimateCost({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 900_000 } as any, 'claude-haiku-4-5');
console.log('1M input of which 900k cache reads on claude-haiku-4-5: SDK says $' + cached, '- Anthropic bills $' + (0.1 * 1 + 0.9 * 0.1).toFixed(2));
