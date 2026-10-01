/**
 * Dependency-free token estimation (LOU-W1).
 *
 * A heuristic, not a tokenizer: it exists so budgeting and context-compaction
 * code can answer "roughly how big is this prompt?" without shipping a
 * tokenizer for every provider.
 */

import type { Message } from '../providers/llm';

/** Anything `estimateTokens` accepts. */
export type TokenEstimateInput = string | Message | Message[];

/** A replacement estimator, e.g. one backed by `tiktoken` or a provider's count endpoint. */
export type TokenEstimator = (input: TokenEstimateInput, options: { model?: string }) => number;

/** Options for {@link estimateTokens}. */
export interface EstimateTokensOptions {
  /**
   * Model id the estimate is for. The built-in heuristic ignores it; it is
   * forwarded to custom estimators so they can pick a model-specific tokenizer.
   */
  model?: string;
  /** Use this estimator for this call instead of the built-in heuristic (or the one set with `setTokenEstimator`). */
  estimator?: TokenEstimator;
}

/** Tokens added per message for role markers and framing. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Tokens per code point for Latin/ASCII text (~4 chars per token). */
const LATIN_WEIGHT = 0.25;
/** CJK ideographs, kana and Hangul: about one token per character. */
const CJK_WEIGHT = 1;
/** Other non-Latin scripts (Cyrillic, Arabic, Hebrew, Thai, Indic, ...). */
const OTHER_SCRIPT_WEIGHT = 0.5;
/** Emoji and pictographs usually cost several byte-level tokens. */
const EMOJI_WEIGHT = 2;

type Range = readonly [number, number];

/** Code point ranges for CJK ideographs, kana, Hangul and CJK punctuation. */
const CJK_RANGES: readonly Range[] = [
  [0x2e80, 0x2fdf],
  [0x3000, 0x303f],
  [0x3040, 0x30ff],
  [0x3100, 0x312f],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
  [0x20000, 0x2fa1f],
];

/** Code point ranges for emoji and pictographs. */
const EMOJI_RANGES: readonly Range[] = [
  [0x2600, 0x27bf],
  [0x1f000, 0x1faff],
];

/** Zero-width joiner, variation selectors and combining marks glue characters together and cost nothing extra. */
const ZERO_WEIGHT_RANGES: readonly Range[] = [
  [0x0300, 0x036f],
  [0x200d, 0x200d],
  [0xfe00, 0xfe0f],
];

function inRanges(cp: number, ranges: readonly Range[]): boolean {
  return ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function codePointWeight(cp: number): number {
  if (cp < 0x0300) return LATIN_WEIGHT;
  if (inRanges(cp, ZERO_WEIGHT_RANGES)) return 0;
  if (inRanges(cp, CJK_RANGES)) return CJK_WEIGHT;
  if (inRanges(cp, EMOJI_RANGES)) return EMOJI_WEIGHT;
  return OTHER_SCRIPT_WEIGHT;
}

function estimateText(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    tokens += codePointWeight(ch.codePointAt(0) ?? 0);
  }
  return Math.ceil(tokens);
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value) ?? '';
}

function estimateMessage(message: Message): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS + estimateText(toText(message.content));
  if (message.name) tokens += estimateText(message.name);
  if (message.toolName) tokens += estimateText(message.toolName);
  if (message.toolCalls?.length) tokens += estimateText(JSON.stringify(message.toolCalls));
  return tokens;
}

function defaultEstimator(input: TokenEstimateInput): number {
  if (typeof input === 'string') return estimateText(input);
  if (Array.isArray(input)) return input.reduce((sum, m) => sum + estimateMessage(m), 0);
  return estimateMessage(input);
}

let globalEstimator: TokenEstimator = defaultEstimator;

/**
 * Replace the estimator used by every `estimateTokens` call, e.g. with a real
 * tokenizer. Call with no argument to restore the built-in heuristic.
 *
 * @example
 * setTokenEstimator((input) => countWithMyTokenizer(input));
 */
export function setTokenEstimator(estimator?: TokenEstimator): void {
  globalEstimator = estimator ?? defaultEstimator;
}

/**
 * Estimate how many tokens a string, message or conversation will use.
 *
 * Heuristic, no tokenizer: about 4 characters per token for Latin text,
 * about 1 token per CJK character, about 0.5 per character for other
 * non-Latin scripts and 2 per emoji (code points are counted, not UTF-16
 * units), plus 4 tokens of overhead per message and the JSON length of tool
 * calls. Tool results are the message `content` (typically JSON) and are
 * counted as text.
 *
 * Accuracy: an estimate for budgeting and compaction decisions. It is
 * typically within ~15-20% for English prose and can be further off for
 * code, minified JSON or rare scripts. It is NOT suitable for billing; use
 * the usage a provider reports for that.
 *
 * @example
 * estimateTokens('Hello, world!');                         // 4
 * estimateTokens([{ role: 'user', content: 'Hi there' }]); // 6
 * estimateTokens(messages, { estimator: myTokenizer });
 */
export function estimateTokens(input: TokenEstimateInput, options: EstimateTokensOptions = {}): number {
  const estimator = options.estimator ?? globalEstimator;
  return estimator(input, { model: options.model });
}
