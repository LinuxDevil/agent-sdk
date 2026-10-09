/**
 * LOU-V13: the `reasoning` option and how each built-in provider sends it.
 *
 * The option names were checked against the provider packages' sources:
 * `@ai-sdk/openai` 1.3 and 4.0 (`providerOptions.openai.reasoningEffort`,
 * `reasoningSummary` on the Responses API), `@ai-sdk/anthropic` 1.2 and 4.0
 * (`providerOptions.anthropic.thinking: { type: 'enabled', budgetTokens }`;
 * the package adds the budget to `max_tokens` and drops `temperature`/`topP`)
 * and `ollama-ai-provider-v2` 4.0 (`providerOptions.ollama.think`). `ai` 4.3
 * and 6/7 both take `providerOptions` on `generateText()` / `streamText()`.
 * OpenRouter gets its unified `reasoning` body field (see OpenRouterProvider).
 */

/** How hard the model should think. `'none'` sends nothing. */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

/** The object form of {@link ReasoningOption}. */
export interface ReasoningSettings {
  /** Default `'medium'`. */
  effort?: ReasoningEffort;
  /** A token budget (Anthropic thinking, OpenRouter `max_tokens`); other providers use `effort`. */
  budgetTokens?: number;
  /** `'auto'` asks OpenAI's Responses API for a reasoning summary. */
  summary?: 'auto' | 'none';
  /** Send the options even when the model is not in the known reasoning families. */
  force?: boolean;
}

/**
 * `createAgent({ reasoning })`, `send(input, { reasoning })`: an effort, or
 * {@link ReasoningSettings}. See docs/reasoning.md for the provider mapping.
 *
 * @example
 * ```ts
 * const reasoning: ReasoningOption = { effort: 'high', summary: 'auto' };
 * ```
 */
export type ReasoningOption = ReasoningEffort | ReasoningSettings;

type Effort = Exclude<ReasoningEffort, 'none'>;

interface Resolved {
  effort: Effort;
  budgetTokens?: number;
  summary?: 'auto' | 'none';
}

/** Model ids, per provider, of the families known to accept reasoning options (bypassed by `force`). */
const REASONING_MODELS: Record<string, RegExp> = {
  openai: /^(?!o1-(mini|preview))(o[1-9]|gpt-[5-9])(?!.*-chat)/,
  anthropic: /^claude-(3-7|(sonnet|opus|haiku|fable)-[4-9])/,
  openrouter: /\/(o[1-9]|gpt-[5-9])|claude-(3[.-]7|(sonnet|opus|haiku|fable)-[4-9])|deepseek-(r1|v3[.-][1-9])|gpt-oss|gemini-(2\.5|[3-9])|grok-[3-9]|qwen3|:thinking$/,
  ollama: /deepseek-r1|qwen3|gpt-oss|magistral/,
};

/** Anthropic thinking budget per effort, in tokens (1024 is Anthropic's minimum). */
const THINKING_BUDGETS: Record<Effort, number> = { minimal: 1024, low: 2048, medium: 8192, high: 24576 };

const warnedNotSent = new Set<string>();

/** F10: warns (once per provider and model) that `reasoning` is set but is not sent, so it is not dropped silently. */
function warnNotSent(provider: string, modelId: string): void {
  const key = `${provider}/${modelId}`;
  if (warnedNotSent.has(key)) return;
  warnedNotSent.add(key);
  console.warn(
    `[lousho] \`reasoning\` is set but is not sent to ${provider} model '${modelId}': it is not in the known reasoning families. ` +
      "If the model does reason, pass { effort, force: true }. See docs/reasoning.md#which-models-get-it."
  );
}

/** The settings to send to `provider`'s `modelId`, or `undefined` when nothing is sent. */
function resolveReasoning(provider: string, modelId: string, option: ReasoningOption | undefined): Resolved | undefined {
  if (option === undefined) return undefined;
  const { effort = 'medium', budgetTokens, summary, force } = typeof option === 'string' ? { effort: option } : option;
  const known = REASONING_MODELS[provider];
  if (effort === 'none') return undefined;
  if (!known || !(force || known.test(modelId))) {
    warnNotSent(provider, modelId);
    return undefined;
  }
  return { effort, budgetTokens, summary };
}

const PROVIDER_OPTIONS: Record<string, (settings: Resolved) => Record<string, unknown>> = {
  openai: ({ effort, summary }) => ({ openai: { reasoningEffort: effort, ...(summary === 'auto' && { reasoningSummary: 'auto' }) } }),
  anthropic: ({ effort, budgetTokens }) => ({
    anthropic: { thinking: { type: 'enabled', budgetTokens: Math.max(1024, budgetTokens ?? THINKING_BUDGETS[effort]) } },
  }),
  ollama: () => ({ ollama: { think: true } }),
};

/** The `providerOptions` that carry `option` for a built-in provider's model, or `undefined`. */
export function reasoningProviderOptions(provider: string, modelId: string, option: ReasoningOption | undefined): Record<string, unknown> | undefined {
  const resolved = resolveReasoning(provider, modelId, option);
  return resolved && PROVIDER_OPTIONS[provider]?.(resolved);
}

/** OpenRouter's unified `reasoning` request field: `max_tokens` when a budget is given, else `effort`. */
export function openRouterReasoning(modelId: string, option: ReasoningOption | undefined): Record<string, unknown> | undefined {
  const resolved = resolveReasoning('openrouter', modelId, option);
  if (!resolved) return undefined;
  return { reasoning: resolved.budgetTokens ? { max_tokens: resolved.budgetTokens } : { effort: resolved.effort } };
}
