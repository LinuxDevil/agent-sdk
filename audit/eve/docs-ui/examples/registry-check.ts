import { getModelInfo, estimateCost } from '../../../../src/models/registry';
for (const m of ['gpt-4o-mini', 'openai/gpt-4o-mini', 'openrouter/openai/gpt-4o-mini']) {
  console.log(m, '| contextWindow:', getModelInfo(m)?.contextWindow, '| cost(1M in):', estimateCost({ inputTokens: 1_000_000, outputTokens: 0 } as any, m));
}
