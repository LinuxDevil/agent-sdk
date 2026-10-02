/**
 * `createAgent({ compaction })` (LOU-W3.2): turns the option into the
 * compaction hook it installs.
 */

import type { LLMProvider } from '../providers/llm';
import type { AgentHook } from '../execution/hooks';
import { ConfigurationError } from '../execution/errors';
import { createCompactionHook, twoPhaseStrategy, type CompactMessagesOptions, type CompactionHookOptions } from './compaction';

/** The object form of `createAgent({ compaction })`. */
export interface AgentCompactionOptions extends Pick<CompactionHookOptions, 'strategy' | 'thresholdPercent' | 'contextWindow' | 'protectedTokens'> {
  /**
   * A model that summarizes old turns: a `"provider/model"` spec or an
   * `LLMProvider`. Selects `twoPhaseStrategy()` with it (prune first, then
   * summarize if still too big). Do not combine it with `strategy`.
   */
  summarizer?: LLMProvider | string;
}

/** What `createAgent({ compaction })` takes: `true` for the defaults, or {@link AgentCompactionOptions}. */
export type AgentCompaction = boolean | AgentCompactionOptions;

/** The hook `createAgent({ compaction })` installs, or `undefined` when it is `false` or absent. */
export function compactionHookFor(compaction: AgentCompaction | undefined): AgentHook | undefined {
  if (!compaction) return undefined;
  const { summarizer, ...options } = compaction === true ? ({} as AgentCompactionOptions) : compaction;
  if (summarizer !== undefined && options.strategy) {
    throw new ConfigurationError(
      "createAgent: compaction has both 'strategy' and 'summarizer'. 'summarizer' selects twoPhaseStrategy(); " +
        "drop it and pass your own strategy (e.g. twoPhaseStrategy({ model, protectedTokens })) as 'strategy'.",
      'compaction',
      'LOUSHO_CONFIG_CONFLICTING_OPTIONS'
    );
  }
  return createCompactionHook({
    ...options,
    ...(summarizer !== undefined && { strategy: twoPhaseStrategy({ model: summarizer }) }),
  });
}

/** The options `session.compact()` runs with for an agent's `compaction` (LOU-W8): its strategy (`summarizer` selects `twoPhaseStrategy()`) and sizes. */
export function manualCompactionOptions(compaction: AgentCompaction | undefined): CompactMessagesOptions {
  if (!compaction || compaction === true) return {};
  const { summarizer, strategy, contextWindow, protectedTokens } = compaction;
  return { strategy: strategy ?? (summarizer === undefined ? undefined : twoPhaseStrategy({ model: summarizer })), contextWindow, protectedTokens };
}
