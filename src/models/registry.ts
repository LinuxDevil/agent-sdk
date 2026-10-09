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
  /**
   * USD per million input tokens read from the provider's prompt cache
   * (`usage.cachedInputTokens`). Unset: billed at `inputCostPerMTok`.
   */
  cachedInputCostPerMTok?: number;
  /**
   * USD per million input tokens written to the prompt cache
   * (`usage.cacheWriteTokens`; Anthropic's 5-minute writes). Unset: billed at
   * `inputCostPerMTok` (OpenAI charges nothing extra for writes).
   */
  cacheWriteCostPerMTok?: number;
}

const registry = new Map<string, ModelInfo>();
for (const info of BUILT_IN_MODELS) registry.set(info.id, info);

/** `feature\0model` pairs the fallback context window was already warned about (one console.warn each). */
const warnedUnknownWindow = new Set<string>();

/**
 * One `console.warn` per (feature, model) pair, for when `feature` fell back
 * to `assumed` context tokens because the registry does not know `model` -
 * a local or unregistered model otherwise sizes its compactions against a
 * silently wrong window (e.g. a 128k assumption against an 8k llama.cpp
 * server). Passing the feature's explicit `contextWindow`, or
 * `registerModel({ id, provider, contextWindow })`, is the fix.
 */
export function warnUnknownContextWindow(feature: string, model: string | undefined, assumed: number): void {
  const key = `${feature}|${model ?? ''}`;
  if (warnedUnknownWindow.has(key)) return;
  warnedUnknownWindow.add(key);
  console.warn(
    `[lousho] ${feature}: ${model === undefined ? 'no model id was given' : `model '${model}' is not in the model registry`}, ` +
      `so a context window of ${assumed.toLocaleString('en-US')} tokens is assumed. ` +
      `If the real window differs, pass 'contextWindow' or registerModel({ id: '${model ?? '<id>'}', provider: '<provider>', contextWindow: <tokens> }).`
  );
}

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

/**
 * A snapshot/tag suffix: a date (`-2024-07-18`, `-20251001`, `-0613`), `-latest`,
 * or a `:tag` / `@version`. A bare `-7b-instruct` or `-5` names a different
 * model, not a snapshot of this one.
 */
const SNAPSHOT_SUFFIX = /^([:@]|-latest|-\d{4}-\d{2}-\d{2}(?!\d)|-\d{8}(?!\d)|-\d{4}(?!\d))/;

/** A model id with version dots written as dashes, so `claude-haiku-4.5` (OpenRouter) and `claude-haiku-4-5` (Anthropic) are one key. */
const canonical = (id: string): string => id.toLowerCase().replace(/(\d)\.(?=\d)/g, '$1-');

function lookupExactOrPrefix(id: string): ModelInfo | undefined {
  const exact = registry.get(id);
  if (exact) return exact;
  const wanted = canonical(id);
  let best: ModelInfo | undefined;
  let bestLength = -1;
  for (const info of registry.values()) {
    const key = canonical(info.id);
    const matches = wanted === key || (wanted.startsWith(key) && SNAPSHOT_SUFFIX.test(wanted.slice(key.length)));
    if (matches && key.length > bestLength) {
      best = info;
      bestLength = key.length;
    }
  }
  return best;
}

/**
 * Look up a model. Matching order: exact id (`.` and `-` between version digits
 * are the same, so `claude-haiku-4.5` finds `claude-haiku-4-5`), then the longest registered id
 * the given id is a dated snapshot of (so `gpt-4o-mini-2024-07-18` resolves to
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

/** A token count, or 0 for a missing or invalid one. */
const countOf = (value: number | undefined): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * Estimate the USD cost of a request from its token usage. Returns
 * `undefined` (never 0) when the model, or either of its prices, is unknown.
 * `cachedInputTokens` and `cacheWriteTokens` are parts of `inputTokens` and
 * are priced at the model's `cachedInputCostPerMTok`/`cacheWriteCostPerMTok`
 * (Eve PROV-F4), or at the input price when the model has none.
 * Built-in prices are a dated snapshot: register your own with
 * {@link registerModel} for billing-grade numbers.
 *
 * @example
 * estimateCost({ inputTokens: 1_000_000, outputTokens: 0 }, 'gpt-4o'); // 2.5
 * estimateCost({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 }, 'gpt-4o'); // 1.25
 */
export function estimateCost(
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number },
  model: string
): number | undefined {
  const info = getModelInfo(model);
  if (info?.inputCostPerMTok === undefined || info.outputCostPerMTok === undefined) return undefined;
  const input = countOf(usage.inputTokens);
  const cached = Math.min(countOf(usage.cachedInputTokens), input);
  const written = Math.min(countOf(usage.cacheWriteTokens), input - cached);
  const inputCost =
    (input - cached - written) * info.inputCostPerMTok +
    cached * (info.cachedInputCostPerMTok ?? info.inputCostPerMTok) +
    written * (info.cacheWriteCostPerMTok ?? info.inputCostPerMTok);
  return (inputCost + usage.outputTokens * info.outputCostPerMTok) / 1_000_000;
}
