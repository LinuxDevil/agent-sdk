/**
 * Usage and cost accounting types (LOU-V5).
 *
 * `Usage` is the one normalized shape for "tokens spent"; `RunUsage` is the
 * running total an `ExecutionResult` carries. Providers report the 'ai' SDK's
 * `promptTokens`/`completionTokens` naming (`ProviderUsage`); the executor
 * converts it with {@link normalizeUsage}.
 */

import type { ProviderUsage } from '../providers/llm';

/** Normalized token usage of one model call. */
export interface Usage {
  /** Tokens sent to the model (the prompt). */
  inputTokens: number;
  /** Tokens the model generated. */
  outputTokens: number;
  /** `inputTokens + outputTokens`, or the provider's own total. */
  totalTokens: number;
  /** Input tokens served from the provider's prompt cache. Only set when the provider reports it. */
  cachedInputTokens?: number;
  /** Output tokens spent on hidden reasoning. Only set when the provider reports it. */
  reasoningTokens?: number;
}

/** Per-model slice of a {@link RunUsage}. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** USD for these tokens; `undefined` when the model's price is unknown (see `registerModel`). */
  costUsd?: number;
  /** Number of model calls made with this model. */
  calls: number;
}

/** Usage that child agents (delegated through `createDelegateTool`) spent; already included in the run totals. */
export interface DelegatedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** `undefined` when any contributing model has unknown pricing. */
  costUsd: number | undefined;
  modelCalls: number;
  estimated: boolean;
  /** Number of child runs. */
  runs: number;
}

/**
 * Running usage of an agent run, on `ExecutionResult.usage`. Totals include
 * every step and every delegated child run.
 *
 * @example
 * ```ts
 * const result = await AgentExecutor.execute({ agent, input, provider });
 * console.log(formatUsage(result.usage)); // 1,234 in / 567 out tokens · $0.0042 (2 model calls)
 * ```
 */
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Sum of `cachedInputTokens` over the calls that reported it; absent when none did. */
  cachedInputTokens?: number;
  /** Sum of `reasoningTokens` over the calls that reported it; absent when none did. */
  reasoningTokens?: number;
  /**
   * Estimated USD for the whole run. `undefined` (never a partial sum) when
   * any contributing model has unknown pricing; the per-model figures in
   * `byModel` still show which models are priced.
   */
  costUsd: number | undefined;
  /** Model calls made, including those of delegated children. */
  modelCalls: number;
  /** `true` when at least one call reported no usage and its tokens were estimated with `estimateTokens`. */
  estimated: boolean;
  /** Breakdown keyed by the model id each call was made with. */
  byModel: Record<string, ModelUsage>;
  /** Present when the run delegated to child agents. */
  delegated?: DelegatedUsage;
  /**
   * N1a: hosted tool calls the provider ran (`webSearch()` and the like), per
   * tool name; absent when there were none. Their fees are billed by the
   * provider and are not in `costUsd`.
   */
  hostedToolCalls?: Partial<Record<string, number>>;
  /** @deprecated Alias of `inputTokens`, kept for code written before LOU-V5. */
  promptTokens: number;
  /** @deprecated Alias of `outputTokens`, kept for code written before LOU-V5. */
  completionTokens: number;
}

/** Usage of one model call within a run (`ExecutionResult.stepUsage`). */
export interface StepUsage {
  /** 1-based loop step the call belongs to. */
  step: number;
  /** The model the call was made with. */
  model: string;
  usage: Usage;
  /** `true` when the provider reported nothing and `usage` is an `estimateTokens` estimate. */
  estimated: boolean;
  /** USD for this call; `undefined` when the model's price is unknown. */
  costUsd?: number;
}

/** What one model call spent: a {@link StepUsage} before it is assigned a loop step. */
export type CallUsage = Omit<StepUsage, 'step'>;

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Convert what a provider reported into {@link Usage}. Returns `undefined`
 * (never zeros) when the provider reported nothing usable, e.g. the 'ai' SDK's
 * `NaN` for a backend that omits token counts.
 *
 * @example
 * normalizeUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
 * // { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
 */
export function normalizeUsage(raw: ProviderUsage | undefined): Usage | undefined {
  if (!raw || !isCount(raw.promptTokens) || !isCount(raw.completionTokens)) return undefined;
  return {
    inputTokens: raw.promptTokens,
    outputTokens: raw.completionTokens,
    totalTokens: isCount(raw.totalTokens) ? raw.totalTokens : raw.promptTokens + raw.completionTokens,
    ...(isCount(raw.cachedInputTokens) ? { cachedInputTokens: raw.cachedInputTokens } : {}),
    ...(isCount(raw.reasoningTokens) ? { reasoningTokens: raw.reasoningTokens } : {}),
  };
}

function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(costUsd >= 1 ? 2 : 4)}`;
}

/**
 * One-line summary of a run's usage for logs and CLIs. A leading `~` marks
 * estimated token counts; the cost part is left out when it is unknown.
 *
 * @example
 * formatUsage(result.usage); // "1,234 in / 567 out tokens · $0.0042 (2 model calls)"
 */
export function formatUsage(
  usage: Pick<RunUsage, 'inputTokens' | 'outputTokens' | 'costUsd' | 'modelCalls' | 'estimated'>
): string {
  const n = (value: number): string => value.toLocaleString('en-US');
  const tokens = `${usage.estimated ? '~' : ''}${n(usage.inputTokens)} in / ${n(usage.outputTokens)} out tokens`;
  const cost = usage.costUsd === undefined ? '' : ` · ${formatCost(usage.costUsd)}`;
  const calls = `${usage.modelCalls} model call${usage.modelCalls === 1 ? '' : 's'}`;
  return `${tokens}${cost} (${calls})`;
}
