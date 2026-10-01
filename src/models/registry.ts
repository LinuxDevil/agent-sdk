/**
 * Model registry: context windows and prices (LOU-W1).
 */

import { BUILT_IN_MODELS } from './modelData';

/** Static facts about a model. */
export interface ModelInfo {
  /** Model id as sent to the provider, e.g. `gpt-4o-mini`. */
  id: string;
  /** Provider name, e.g. `openai`, `anthropic`, `ollama`. */
  provider: string;
  /** Maximum tokens of context. */
  contextWindow: number;
  /** Maximum tokens the model can generate in one response. */
  maxOutputTokens?: number;
  /** USD per million input tokens. */
  inputCostPerMTok?: number;
  /** USD per million output tokens. */
  outputCostPerMTok?: number;
}

const registry = new Map<string, ModelInfo>();
for (const info of BUILT_IN_MODELS) registry.set(info.id, info);

/**
 * Add a model or override a built-in one (later registration wins). Use this
 * for self-hosted or fine-tuned models, and to override the built-in price
 * snapshot with your own prices.
 *
 * @example
 * registerModel({ id: 'my-llama', provider: 'ollama', contextWindow: 32768 });
 */
export function registerModel(info: ModelInfo): void {
  registry.set(info.id, { ...info });
}

/** A snapshot/tag suffix: `-2024-07-18`, `-20251001`, `-latest`, `:8b`, `@20251001`. */
const SNAPSHOT_SUFFIX = /^([:@]|-(\d|latest))/;

function lookupExactOrPrefix(id: string): ModelInfo | undefined {
  const exact = registry.get(id);
  if (exact) return exact;
  let best: ModelInfo | undefined;
  for (const info of registry.values()) {
    const isSnapshot = id.startsWith(info.id) && SNAPSHOT_SUFFIX.test(id.slice(info.id.length));
    if (isSnapshot && (!best || info.id.length > best.id.length)) best = info;
  }
  return best;
}

/**
 * Look up a model. Matching order: exact id, then the longest registered id
 * the given id is a snapshot of (so `gpt-4o-mini-2024-07-18` resolves to
 * `gpt-4o-mini`, but `o3-mini` does not resolve to `o3`), each also tried
 * without a `provider/` prefix (as in `resolveProvider('openai/gpt-4o-mini')`).
 * Returns `undefined` for unknown models.
 *
 * @example
 * getModelInfo('openai/gpt-4o-mini')?.contextWindow; // 128000
 */
export function getModelInfo(model: string): ModelInfo | undefined {
  const direct = lookupExactOrPrefix(model);
  if (direct) return direct;
  const slash = model.indexOf('/');
  return slash > 0 ? lookupExactOrPrefix(model.slice(slash + 1)) : undefined;
}

/**
 * Estimate the USD cost of a request from its token usage. Returns
 * `undefined` (never 0) when the model, or either of its prices, is unknown.
 * Built-in prices are a dated snapshot: register your own with
 * {@link registerModel} for billing-grade numbers.
 *
 * @example
 * estimateCost({ inputTokens: 1_000_000, outputTokens: 0 }, 'gpt-4o'); // 2.5
 */
export function estimateCost(
  usage: { inputTokens: number; outputTokens: number },
  model: string
): number | undefined {
  const info = getModelInfo(model);
  if (info?.inputCostPerMTok === undefined || info.outputCostPerMTok === undefined) return undefined;
  return (usage.inputTokens * info.inputCostPerMTok + usage.outputTokens * info.outputCostPerMTok) / 1_000_000;
}
