/**
 * Context compaction (LOU-W2, LOU-W3): keep a long run under its model's
 * context window by pruning old tool results and, when that is not enough,
 * folding old turns into a model-written summary.
 *
 * Ships as an `AgentHook` (`createCompactionHook()`), so it needs no changes
 * to the execution loop: `preGenerate` runs before every model call, and
 * `ctx.request.messages` IS the run's transcript array (AgentExecutor passes
 * `state.messages` itself into the request, see `prepareGenerateRequest()` in
 * src/execution/generateStep.ts). The hook rewrites that array in place, so a
 * pruned result stays pruned in later steps, in checkpoints and in
 * `ExecutionResult.messages`, and is not pruned again on the next step.
 */

import type { LLMProvider, Message } from '../providers/llm';
import { textOf } from '../providers/content';
import { resolveProvider } from '../providers/resolveProvider';
import type { AgentHook, GenerateHookContext } from '../execution/hooks';
import { estimateTokens } from '../models/estimateTokens';
import { SDKError } from '../execution/errors';
import { requestOverheadTokens, resolveContextWindow } from './contextWindow';

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
  /** The size (`thresholdPercent` of the window) a compacted conversation should end up under. */
  thresholdTokens: number;
  /** The run's cancellation signal, for strategies that call a model. */
  signal?: AbortSignal;
}

/** What a {@link CompactionStrategy} returns. */
export interface CompactionResult {
  /** The compacted conversation (the input array itself when nothing changed). */
  messages: Message[];
  tokensBefore: number;
  tokensAfter: number;
  /** `toolCallId`s whose results were replaced by a marker. */
  prunedToolCallIds: string[];
  /** The summary that replaced old turns, when the strategy summarized. */
  summary?: string;
  /** Why the strategy fell back (e.g. the summarizer failed); `messages` is then the fallback result. */
  error?: Error;
}

/** A way of shrinking a conversation. `compact()` may be async (e.g. to call a model). */
export interface CompactionStrategy {
  name: string;
  compact(input: CompactionInput): CompactionResult | Promise<CompactionResult>;
}

/**
 * Returns a copy of `message` marked as pinned (`metadata.pinned: true`).
 * The built-in strategies never prune or summarize a pinned message.
 *
 * @example
 * messages.push(pinMessage({ role: 'user', content: 'Always answer in French.' }));
 */
export function pinMessage(message: Message): Message {
  return { ...message, metadata: { ...message.metadata, pinned: true } };
}

/** Whether `message` was marked with {@link pinMessage}. */
export function isPinned(message: Message): boolean {
  return message.metadata?.pinned === true;
}

const DEFAULT_PROTECTED_TOKENS = 40_000;
const DEFAULT_THRESHOLD_PERCENT = 0.9;

const PRUNED_MARKER = /^\[pruned: .* result, \d+ chars\]$/;

/** The strategy a marked (LOU-R11) transcript compacts with: prune only, never summarize. */
const PRUNE_ONLY = pruneToolResultsStrategy();

const toError = (cause: unknown): Error => (cause instanceof Error ? cause : new Error(String(cause)));

/** The message with its result replaced by a marker, or `undefined` when it is not a tool result worth pruning. */
function prunedToolResult(message: Message): Message | undefined {
  const text = textOf(message);
  if (message.role !== 'tool' || isPinned(message) || PRUNED_MARKER.test(text)) return undefined;
  const marker = `[pruned: ${message.toolName ?? 'tool'} result, ${text.length} chars]`;
  return marker.length < text.length ? { ...message, content: marker } : undefined;
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
 * transcript stays valid. A pinned result, a result that is already a
 * marker, or one shorter than a marker is left alone, so running it again
 * changes nothing.
 */
export function pruneToolResultsStrategy(): CompactionStrategy {
  return {
    name: 'prune-tool-results',
    compact: pruneToolResults,
  };
}

function pruneToolResults({ messages, estimateTokens: count, protectedTokens }: CompactionInput): CompactionResult {
  const tokensBefore = count(messages);
  const tailStart = protectedTailStart(messages, count, protectedTokens);
  const compacted = messages.map((message, index) => (index < tailStart && prunedToolResult(message)) || message);
  const pruned = compacted.filter((message, index) => message !== messages[index]);
  const prunedToolCallIds = pruned.flatMap((message) => (message.toolCallId ? [message.toolCallId] : []));
  if (pruned.length === 0) return { messages, tokensBefore, tokensAfter: tokensBefore, prunedToolCallIds };
  return { messages: compacted, tokensBefore, tokensAfter: count(compacted), prunedToolCallIds };
}

/** Options for {@link summarizeStrategy} and {@link twoPhaseStrategy}. */
export interface SummarizeStrategyOptions {
  /** The summarizer: a provider, or a `"provider/model"` spec for `resolveProvider()` (a cheap model is fine). */
  model: LLMProvider | string;
  /** Recent tokens kept as they are. Defaults to the hook's `protectedTokens`. */
  protectedTokens?: number;
  /** Instruction sent to the summarizer as its system message. Defaults to {@link DEFAULT_SUMMARY_PROMPT}. */
  prompt?: string;
  /** `maxTokens` for the summary call. Defaults to the provider's default. */
  maxSummaryTokens?: number;
}

/** The summarizer's default instruction. */
export const DEFAULT_SUMMARY_PROMPT = `You compact the history of an AI agent's conversation. Summarize it so the agent can continue without it:
1. Goal: what the user wants.
2. Instructions: directives and constraints the user gave.
3. Progress: what has been done, which tools were called and what they returned.
4. State: where things stand and what is still pending.
5. Details: names, ids, paths, numbers and values needed to continue.
Write only the summary.`;

/** The first line of the message that replaces summarized turns. */
export const SUMMARY_HEADER = '[Conversation summary]';

function renderForSummary(messages: Message[]): string {
  return messages
    .map((m) => {
      const calls = (m.toolCalls ?? []).map((c) => `\n[called ${c.function.name}(${c.function.arguments})]`).join('');
      return `${m.role === 'tool' ? `tool ${m.toolName ?? ''}`.trim() : m.role}: ${textOf(m)}${calls}`;
    })
    .join('\n\n');
}

/**
 * Splits the messages before the protected tail into the ones to summarize
 * and the ones to keep. An assistant turn and the tool results that follow it
 * form one group, kept or folded whole, so no tool call loses its result; a
 * group is kept if it holds a system or pinned message. The tail always holds
 * the last message and starts on a group boundary. `summaryAt` is where the
 * summary goes in `kept`: the position of the first folded group.
 */
function splitForSummary(messages: Message[], count: CompactionTokenCounter, protectedTokens: number) {
  let tailStart = Math.min(protectedTailStart(messages, count, protectedTokens), messages.length - 1);
  while (tailStart > 0 && messages[tailStart].role === 'tool') tailStart--;
  const kept: Message[] = [];
  const folded: Message[] = [];
  let summaryAt = -1;
  for (let i = 0; i < tailStart; ) {
    let end = i + 1;
    if (messages[i].role === 'assistant') while (end < tailStart && messages[end].role === 'tool') end++;
    const group = messages.slice(i, end);
    if (group.some((m) => m.role === 'system' || isPinned(m))) {
      kept.push(...group);
    } else {
      if (summaryAt < 0) summaryAt = kept.length;
      folded.push(...group);
    }
    i = end;
  }
  return { kept, folded, summaryAt, tail: messages.slice(tailStart) };
}

/**
 * Replaces the turns before the protected tail with one `user` message,
 * `"[Conversation summary]\n<summary>"`, written by `model`. System and
 * pinned messages are kept, and an assistant turn is summarized together with
 * its tool results, so the transcript stays valid for every provider. If the
 * summary call fails, it falls back to {@link pruneToolResultsStrategy} and
 * reports the failure as `error`; it never throws.
 *
 * @example
 * createCompactionHook({ strategy: summarizeStrategy({ model: 'openai/gpt-4o-mini' }) });
 */
export function summarizeStrategy(options: SummarizeStrategyOptions): CompactionStrategy {
  let provider: LLMProvider | undefined;
  return {
    name: 'summarize',
    async compact(input) {
      const { messages, estimateTokens: count, signal } = input;
      const protectedTokens = options.protectedTokens ?? input.protectedTokens;
      const { kept, folded, summaryAt, tail } = splitForSummary(messages, count, protectedTokens);
      const tokensBefore = count(messages);
      if (folded.length === 0) return { messages, tokensBefore, tokensAfter: tokensBefore, prunedToolCallIds: [] };
      try {
        provider ??= typeof options.model === 'string' ? resolveProvider(options.model) : options.model;
        const { text } = await provider.generate({
          messages: [
            { role: 'system', content: options.prompt ?? DEFAULT_SUMMARY_PROMPT },
            { role: 'user', content: renderForSummary(folded) },
          ],
          maxTokens: options.maxSummaryTokens,
          signal,
        });
        const summary = text.trim();
        if (!summary) throw new SDKError('the summarizer returned an empty summary', 'LOUSHO_AGENT_EXECUTION_FAILED');
        kept.splice(summaryAt, 0, { role: 'user', content: `${SUMMARY_HEADER}\n${summary}` });
        const compacted = [...kept, ...tail];
        return { messages: compacted, tokensBefore, tokensAfter: count(compacted), prunedToolCallIds: [], summary };
      } catch (cause) {
        return { ...pruneToolResults({ ...input, protectedTokens }), error: toError(cause) };
      }
    },
  };
}

/**
 * The recommended strategy: prunes old tool results first and, only if the
 * conversation is still above the threshold, summarizes what is left with
 * {@link summarizeStrategy} (which falls back to the pruned result on failure).
 *
 * @example
 * createCompactionHook({ strategy: twoPhaseStrategy({ model: 'openai/gpt-4o-mini' }) });
 */
export function twoPhaseStrategy(options: SummarizeStrategyOptions): CompactionStrategy {
  const summarize = summarizeStrategy(options);
  return {
    name: 'two-phase',
    async compact(input) {
      const pruned = pruneToolResults(input);
      if (pruned.tokensAfter <= input.thresholdTokens) return pruned;
      const result = await summarize.compact({ ...input, messages: pruned.messages });
      const prunedToolCallIds = [...pruned.prunedToolCallIds, ...result.prunedToolCallIds];
      return { ...result, tokensBefore: pruned.tokensBefore, prunedToolCallIds };
    },
  };
}

/** Options for {@link compactMessages}. */
export interface CompactMessagesOptions {
  /** Defaults to {@link pruneToolResultsStrategy}. */
  strategy?: CompactionStrategy;
  /**
   * Defaults to the model's window in the model registry, else 128,000 (with
   * a one-time `console.warn`). Set it for a local model: LM Studio's loaded
   * context length, Ollama's `num_ctx`.
   */
  contextWindow?: number;
  /** How many recent tokens to keep intact. Defaults to 40,000. */
  protectedTokens?: number;
  /** Share of the context window to compact below (`CompactionInput.thresholdTokens`). Defaults to 0.9. */
  thresholdPercent?: number;
  /**
   * Tokens kept free for the model's reply. When set, the threshold is at
   * most `contextWindow - reserveOutputTokens` (it never rises above
   * `thresholdPercent` of the window). Default: no reserve.
   */
  reserveOutputTokens?: number;
  /** Model id, used for the context-window lookup and passed to the token estimator. */
  model?: string;
}

/** The strategy and input {@link compactMessages} runs with (also used by `session.compact()`, LOU-W8). */
export function prepareCompaction(messages: Message[], options: CompactMessagesOptions, signal?: AbortSignal) {
  const { model, protectedTokens = DEFAULT_PROTECTED_TOKENS, thresholdPercent = DEFAULT_THRESHOLD_PERCENT, reserveOutputTokens } = options;
  const strategy = options.strategy ?? pruneToolResultsStrategy();
  const contextWindow = resolveContextWindow(options.contextWindow, model, 'compaction', 'compaction.contextWindow');
  const count: CompactionTokenCounter = (input) => estimateTokens(input, { model });
  const reserved = reserveOutputTokens === undefined ? Infinity : contextWindow - reserveOutputTokens;
  const thresholdTokens = Math.max(0, Math.min(thresholdPercent * contextWindow, reserved));
  const input: CompactionInput = { messages, estimateTokens: count, contextWindow, protectedTokens, thresholdTokens, signal };
  return { strategy, input };
}

/**
 * Compacts a conversation now, whatever its size. Pure: `messages` is not
 * modified. Use it to shrink a stored transcript by hand; inside a run use
 * {@link createCompactionHook}.
 *
 * @example
 * const { messages: smaller, tokensBefore, tokensAfter } = await compactMessages(history, { protectedTokens: 8_000 });
 */
export async function compactMessages(messages: Message[], options: CompactMessagesOptions = {}): Promise<CompactionResult> {
  const { strategy, input } = prepareCompaction(messages, options);
  return strategy.compact(input);
}

/** Reported to `onCompaction` each time the hook compacts a request. */
export interface CompactionInfo {
  tokensBefore: number;
  tokensAfter: number;
  prunedToolCallIds: string[];
  /** The strategy's `name`. */
  strategy: string;
  /** The summary that replaced old turns, when the strategy summarized. */
  summary?: string;
  /** Set when the strategy failed or fell back; the run continues either way. */
  error?: Error;
}

/** Options for {@link createCompactionHook}. */
export interface CompactionHookOptions extends Omit<CompactMessagesOptions, 'model'> {
  /** Called after each compaction that changed the conversation or reported an `error`. */
  onCompaction?: (info: CompactionInfo) => void;
}

/**
 * An `AgentHook` named `compaction` that compacts the conversation before a
 * model call whose estimated size is above `thresholdPercent` of the context
 * window (looked up by `request.model` unless `contextWindow` is given). The
 * estimate counts the messages, the tool definitions and the output schema,
 * plus whatever the provider's reported prompt tokens exceeded the estimate
 * by on the transcript's previous call. The compacted messages replace the run's transcript in place, so they are what
 * later steps, checkpoints and the result see. The strategy may be async; if
 * it throws, the run continues uncompacted and `onCompaction` gets the `error`.
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
  // LOU-R11: transcripts whose summary was rejected. Keyed on the run's
  // transcript array (ctx.request.messages IS it - it stays the same array
  // through the in-place rewrite below and dies with the run), so a marked
  // transcript prunes only for the rest of that run.
  const rejected = new WeakSet<Message[]>();
  // Per transcript: how many prompt tokens the provider reported for its last
  // call beyond the estimate (framing, hidden prompts, tokenizer differences).
  const underestimate = new WeakMap<Message[], number>();
  return {
    name: 'compaction',
    async preGenerate(ctx: GenerateHookContext) {
      const messages = ctx.request.messages;
      const { strategy, input: prepared } = prepareCompaction(messages, { ...options, model: ctx.request.model }, ctx.request.signal);
      const { contextWindow, thresholdTokens } = prepared;
      // Tool definitions, the output schema and the last call's underestimate count toward the
      // request but cannot be compacted: the conversation has to fit in what is left of the threshold.
      const overhead = requestOverheadTokens(ctx.request) + (underestimate.get(messages) ?? 0);
      const tokens = prepared.estimateTokens(messages) + overhead;
      if (tokens <= thresholdTokens) return;
      const input: CompactionInput = { ...prepared, thresholdTokens: Math.max(0, thresholdTokens - overhead) };
      // A rejected summary is not tried again on this transcript.
      const active = rejected.has(messages) ? PRUNE_ONLY : strategy;
      ctx.emit?.({ type: 'compaction.start', strategy: active.name, tokensBefore: tokens, contextWindow, thresholdTokens });
      let result: CompactionResult;
      try {
        result = await active.compact(input);
      } catch (cause) {
        result = { messages, tokensBefore: tokens - overhead, tokensAfter: tokens - overhead, prunedToolCallIds: [], error: toError(cause) };
      }
      // LOU-R11: a summary that does not shrink the conversation, or that
      // leaves it over the threshold, is rejected. Applied anyway it kept the
      // request over threshold, so the hook summarized again on every step
      // until max-steps. Fall back to pruning alone and mark the transcript,
      // so the rest of the run prunes instead of summarizing each step.
      if (result.summary !== undefined && (result.tokensAfter >= result.tokensBefore || result.tokensAfter > input.thresholdTokens)) {
        rejected.add(messages);
        result = {
          ...pruneToolResults(input),
          error: new SDKError(
            `the summary did not compact the conversation below the threshold (${result.tokensBefore + overhead} -> ${result.tokensAfter + overhead} tokens); this transcript is pruned only for the rest of the run`,
            'LOUSHO_AGENT_EXECUTION_FAILED'
          ),
        };
      }
      // Reported as request sizes: the conversation plus the tool definitions and output schema.
      const { prunedToolCallIds, summary, error } = result;
      const tokensBefore = result.tokensBefore + overhead;
      const tokensAfter = result.tokensAfter + overhead;
      ctx.emit?.({
        type: 'compaction.done',
        strategy: strategy.name,
        tokensBefore,
        tokensAfter,
        prunedToolCallIds,
        ...(summary && { summary: true }),
        ...(error && { error: { message: error.message } }),
      });
      if (result.messages === messages && !error) return;
      // In place: request.messages is the run's transcript (see the file comment).
      if (result.messages !== messages) messages.splice(0, messages.length, ...result.messages);
      onCompaction?.({ tokensBefore, tokensAfter, prunedToolCallIds, strategy: strategy.name, summary, error });
    },
    postGenerate(ctx: GenerateHookContext, generated) {
      // Calibrate the next estimate of this transcript with what the provider billed for this request.
      const reported = generated.usage?.promptTokens;
      if (!reported) return;
      const request = ctx.request;
      const estimated = estimateTokens(request.messages, { model: request.model }) + requestOverheadTokens(request);
      underestimate.set(request.messages, Math.max(0, reported - estimated));
    },
  };
}
