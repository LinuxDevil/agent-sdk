import type { ModelInfo } from './registry';

/**
 * Built-in model table. A dated snapshot, not a live price list.
 *
 * Retrieved 2026-10-01. Sources (provider-published):
 *  - OpenAI: https://developers.openai.com/api/docs/pricing and
 *    https://developers.openai.com/api/docs/models/<model> (standard tier,
 *    short-context prices; context window and max output from each model page)
 *  - Anthropic: https://platform.claude.com/docs/en/docs/about-claude/models/overview
 *    ("128K" max output read as 128000, "1M" context as 1000000)
 *  - Ollama: https://ollama.com/library/<model> (context window only; local
 *    models have no per-token price, so prices are left undefined)
 *
 * Only models whose numbers were read from those pages are listed; anything
 * unverified is left undefined. Override with `registerModel` for
 * billing-grade numbers.
 */
export const BUILT_IN_MODELS: readonly ModelInfo[] = [
  { id: 'gpt-4o', provider: 'openai', contextWindow: 128000, maxOutputTokens: 16384, inputCostPerMTok: 2.5, outputCostPerMTok: 10 },
  { id: 'gpt-4o-mini', provider: 'openai', contextWindow: 128000, maxOutputTokens: 16384, inputCostPerMTok: 0.15, outputCostPerMTok: 0.6 },
  { id: 'gpt-4.1', provider: 'openai', contextWindow: 1047576, maxOutputTokens: 32768, inputCostPerMTok: 2, outputCostPerMTok: 8 },
  { id: 'gpt-4.1-mini', provider: 'openai', contextWindow: 1000000, maxOutputTokens: 32768, inputCostPerMTok: 0.4, outputCostPerMTok: 1.6 },
  { id: 'gpt-4.1-nano', provider: 'openai', contextWindow: 1000000, maxOutputTokens: 32768, inputCostPerMTok: 0.1, outputCostPerMTok: 0.4 },
  { id: 'gpt-5', provider: 'openai', contextWindow: 400000, maxOutputTokens: 128000, inputCostPerMTok: 1.25, outputCostPerMTok: 10 },
  { id: 'gpt-5-mini', provider: 'openai', contextWindow: 400000, maxOutputTokens: 128000, inputCostPerMTok: 0.25, outputCostPerMTok: 2 },
  { id: 'o3', provider: 'openai', contextWindow: 200000, maxOutputTokens: 100000, inputCostPerMTok: 2, outputCostPerMTok: 8 },
  { id: 'o4-mini', provider: 'openai', contextWindow: 200000, maxOutputTokens: 100000, inputCostPerMTok: 1.1, outputCostPerMTok: 4.4 },
  { id: 'claude-fable-5-1', provider: 'anthropic', contextWindow: 1000000, maxOutputTokens: 128000, inputCostPerMTok: 10, outputCostPerMTok: 50 },
  { id: 'claude-opus-5-5', provider: 'anthropic', contextWindow: 1000000, maxOutputTokens: 128000, inputCostPerMTok: 4, outputCostPerMTok: 20 },
  { id: 'claude-sonnet-5-5', provider: 'anthropic', contextWindow: 1000000, maxOutputTokens: 128000, inputCostPerMTok: 2, outputCostPerMTok: 10 },
  { id: 'claude-haiku-4-5', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 64000, inputCostPerMTok: 1, outputCostPerMTok: 5 },
  { id: 'llama3.1', provider: 'ollama', contextWindow: 131072 },
  { id: 'mistral', provider: 'ollama', contextWindow: 32768 },
];
