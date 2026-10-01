/**
 * `session.compact()` (LOU-W8): runs a compaction strategy over a session's
 * transcript now, whatever its size, and reports it as `compaction.start` /
 * `compaction.done` events (`trigger: 'manual'`).
 */

import type { Message } from '../providers/llm';
import { prepareCompaction, type CompactMessagesOptions, type CompactionResult } from '../context/compaction';
import type { AgentEventPayload } from '../execution/agentEvents';

/** Options of `session.compact()`: the session's configured ones, overridden by these. */
export interface SessionCompactOptions extends Pick<CompactMessagesOptions, 'strategy' | 'protectedTokens' | 'contextWindow'> {
  signal?: AbortSignal;
}

/** What `session.compact()` did. */
export interface SessionCompactResult {
  messagesBefore: number;
  messagesAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  /** The strategy's name. */
  strategy: string;
  /** The strategy's failure (e.g. the summarizer failed); the transcript is then what its fallback left, or unchanged. */
  error?: { message: string };
}

/**
 * Compacts `messages` with `options`; never throws on a strategy failure
 * (the messages come back unchanged with `error`, as the automatic hook does).
 */
export async function compactTranscript(
  messages: Message[],
  options: CompactMessagesOptions & { signal?: AbortSignal },
  emit: (event: AgentEventPayload) => void
): Promise<{ messages: Message[]; result: SessionCompactResult }> {
  // thresholdPercent 0: a two-phase strategy summarizes after pruning, however small the transcript.
  const { strategy, input } = prepareCompaction(messages, { ...options, thresholdPercent: 0 }, options.signal);
  const tokensBefore = input.estimateTokens(messages);
  const { contextWindow, thresholdTokens } = input;
  emit({ type: 'compaction.start', strategy: strategy.name, tokensBefore, contextWindow, thresholdTokens, trigger: 'manual' });
  let compacted: CompactionResult;
  try {
    compacted = await strategy.compact(input);
  } catch (cause) {
    compacted = { messages, tokensBefore, tokensAfter: tokensBefore, prunedToolCallIds: [], error: cause instanceof Error ? cause : new Error(String(cause)) };
  }
  const { prunedToolCallIds, summary, error } = compacted;
  const result: SessionCompactResult = {
    messagesBefore: messages.length,
    messagesAfter: compacted.messages.length,
    tokensBefore: compacted.tokensBefore,
    tokensAfter: compacted.tokensAfter,
    strategy: strategy.name,
    ...(error && { error: { message: error.message } }),
  };
  emit({
    type: 'compaction.done',
    strategy: strategy.name,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    prunedToolCallIds,
    ...(summary && { summary: true }),
    ...(error && { error: result.error }),
    trigger: 'manual',
  });
  return { messages: compacted.messages, result };
}
