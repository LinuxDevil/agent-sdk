/**
 * Context compaction (LOU-W2): keep a long run under its model's context
 * window by pruning old tool results.
 *
 * Ships as an `AgentHook` (`createCompactionHook()`), so it needs no changes
 * to the execution loop: `preGenerate` runs before every model call, and
 * `ctx.request.messages` IS the run's transcript array (AgentExecutor passes
 * `state.messages` itself into the request, see `prepareGenerateRequest()` in
 * src/execution/generateStep.ts). The hook rewrites that array in place, so a
 * pruned result stays pruned in later steps, in checkpoints and in
 * `ExecutionResult.messages`, and is not pruned again on the next step.
 */

import type { Message } from '../providers/llm';
import type { AgentHook, GenerateHookContext } from '../execution/hooks';
import { estimateTokens } from '../models/estimateTokens';
import { getModelInfo } from '../models/registry';

/** Counts the tokens of a message or a conversation. */
export type CompactionTokenCounter = (input: Message | Message[]) => number;

/** What a {@link CompactionStrategy} gets to work with. */
export interface CompactionInput {
  /** The conversation to compact. Do not mutate it; return a new array. */
  messages: Message[];
  /** Token counter for the model the request is for. */
  estimateTokens: CompactionTokenCounter;
  /** The model's context window, in tokens. */
  contextWindow: number;
  /** How many of the most recent tokens to leave untouched. */
  protectedTokens: number;
}

/** What a {@link CompactionStrategy} returns. */
export interface CompactionResult {
  /** The compacted conversation (the input array itself when nothing changed). */
  messages: Message[];
  tokensBefore: number;
  tokensAfter: number;
  /** `toolCallId`s whose results were replaced by a marker. */
  prunedToolCallIds: string[];
}

/** A way of shrinking a conversation. */
export interface CompactionStrategy {
  name: string;
  compact(input: CompactionInput): CompactionResult;
}

const DEFAULT_PROTECTED_TOKENS = 40_000;
/** Context window assumed for a model the registry does not know. */
const FALLBACK_CONTEXT_WINDOW = 128_000;
const DEFAULT_THRESHOLD_PERCENT = 0.9;

const PRUNED_MARKER = /^\[pruned: .* result, \d+ chars\]$/;

function prunedMarker(message: Message): string {
  return `[pruned: ${message.toolName ?? 'tool'} result, ${message.content.length} chars]`;
}

/**
 * Index of the first message of the protected tail: the newest messages
 * whose tokens fit in `protectedTokens`, plus everything after the last
 * assistant turn (results the model has not seen yet are never pruned).
 */
function protectedTailStart(messages: Message[], count: CompactionTokenCounter, protectedTokens: number): number {
  let start = messages.length;
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    tokens += count(messages[i]);
    if (tokens > protectedTokens) break;
    start = i;
  }
  const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant');
  return Math.min(start, lastAssistant + 1);
}

/**
 * Replaces the content of tool results older than the protected tail with a
 * short marker such as `[pruned: search result, 18234 chars]`. Only `tool`
 * messages change (system, user and assistant messages, tool calls included,
 * are kept as they are), so every tool call still has its result and the
 * transcript stays valid. A result that is already a marker, or shorter than
 * one, is left alone, so running it again changes nothing.
 */
export function pruneToolResultsStrategy(): CompactionStrategy {
  return {
    name: 'prune-tool-results',
    compact({ messages, estimateTokens: count, protectedTokens }) {
      const tokensBefore = count(messages);
      const tailStart = protectedTailStart(messages, count, protectedTokens);
      const prunedToolCallIds: string[] = [];
      let changed = false;
      const compacted = messages.map((message, index) => {
        if (index >= tailStart || message.role !== 'tool' || PRUNED_MARKER.test(message.content)) return message;
        const marker = prunedMarker(message);
        if (marker.length >= message.content.length) return message;
        changed = true;
        if (message.toolCallId) prunedToolCallIds.push(message.toolCallId);
        return { ...message, content: marker };
      });
      if (!changed) return { messages, tokensBefore, tokensAfter: tokensBefore, prunedToolCallIds };
      return { messages: compacted, tokensBefore, tokensAfter: count(compacted), prunedToolCallIds };
    },
  };
}

/** Options for {@link compactMessages}. */
export interface CompactMessagesOptions {
  /** Defaults to {@link pruneToolResultsStrategy}. */
  strategy?: CompactionStrategy;
  /** Defaults to the model's window in the model registry, else 128,000. */
  contextWindow?: number;
  /** How many recent tokens to keep intact. Defaults to 40,000. */
  protectedTokens?: number;
  /** Model id, used for the context-window lookup and passed to the token estimator. */
  model?: string;
}

function prepare(messages: Message[], options: CompactMessagesOptions) {
  const { model, protectedTokens = DEFAULT_PROTECTED_TOKENS } = options;
  const strategy = options.strategy ?? pruneToolResultsStrategy();
  const contextWindow =
    options.contextWindow ?? (model ? getModelInfo(model)?.contextWindow : undefined) ?? FALLBACK_CONTEXT_WINDOW;
  const count: CompactionTokenCounter = (input) => estimateTokens(input, { model });
  return { strategy, contextWindow, input: { messages, estimateTokens: count, contextWindow, protectedTokens } };
}

/**
 * Compacts a conversation now, whatever its size. Pure: `messages` is not
 * modified. Use it to shrink a stored transcript by hand; inside a run use
 * {@link createCompactionHook}.
 *
 * @example
 * const { messages: smaller, tokensBefore, tokensAfter } = compactMessages(history, { protectedTokens: 8_000 });
 */
export function compactMessages(messages: Message[], options: CompactMessagesOptions = {}): CompactionResult {
  const { strategy, input } = prepare(messages, options);
  return strategy.compact(input);
}

/** Reported to `onCompaction` each time the hook compacts a request. */
export interface CompactionInfo {
  tokensBefore: number;
  tokensAfter: number;
  prunedToolCallIds: string[];
  /** The strategy's `name`. */
  strategy: string;
}

/** Options for {@link createCompactionHook}. */
export interface CompactionHookOptions extends Omit<CompactMessagesOptions, 'model'> {
  /** Compact once the request is estimated above this share of the context window. Defaults to 0.9. */
  thresholdPercent?: number;
  /** Called after each compaction that changed the conversation. */
  onCompaction?: (info: CompactionInfo) => void;
}

/**
 * An `AgentHook` named `compaction` that compacts the conversation before a
 * model call whose estimated size is above `thresholdPercent` of the context
 * window (looked up by `request.model` unless `contextWindow` is given). The
 * compacted messages replace the run's transcript in place, so they are what
 * later steps, checkpoints and the result see.
 *
 * @example
 * const hooks = new HookRegistry();
 * hooks.register(createCompactionHook({ onCompaction: (info) => console.log(info) }));
 * await AgentExecutor.execute({ agent, input, provider, hooks });
 */
export function createCompactionHook(options: CompactionHookOptions = {}): AgentHook {
  const { thresholdPercent = DEFAULT_THRESHOLD_PERCENT, onCompaction } = options;
  if (!(thresholdPercent > 0 && thresholdPercent <= 1)) {
    throw new RangeError(`createCompactionHook: thresholdPercent must be in (0, 1], got ${thresholdPercent}`);
  }
  return {
    name: 'compaction',
    preGenerate(ctx: GenerateHookContext) {
      const messages = ctx.request.messages;
      const { strategy, contextWindow, input } = prepare(messages, { ...options, model: ctx.request.model });
      if (input.estimateTokens(messages) <= thresholdPercent * contextWindow) return;
      const result = strategy.compact(input);
      if (result.messages === messages) return;
      // In place: request.messages is the run's transcript (see the file comment).
      messages.splice(0, messages.length, ...result.messages);
      onCompaction?.({
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        prunedToolCallIds: result.prunedToolCallIds,
        strategy: strategy.name,
      });
    },
  };
}
