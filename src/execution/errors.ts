/**
 * Error Classes
 * Custom error types for SDK operations
 */

import { APICallError, LoadAPIKeyError, RetryError } from 'ai';

/**
 * Base SDK error
 */
export class SDKError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'SDKError';
  }
}

/**
 * Agent execution error
 */
export class AgentExecutionError extends SDKError {
  constructor(
    message: string,
    public readonly agentId?: string,
    public readonly cause?: Error
  ) {
    super(message, 'AGENT_EXECUTION_ERROR');
    this.name = 'AgentExecutionError';
  }
}

/**
 * Tool execution error
 */
export class ToolExecutionError extends SDKError {
  constructor(
    message: string,
    public readonly toolName?: string,
    public readonly cause?: Error
  ) {
    super(message, 'TOOL_EXECUTION_ERROR');
    this.name = 'ToolExecutionError';
  }
}

/**
 * LLM provider error
 */
export class LLMProviderError extends SDKError {
  constructor(
    message: string,
    public readonly providerName?: string,
    public readonly statusCode?: number,
    public readonly cause?: Error
  ) {
    super(message, 'LLM_PROVIDER_ERROR');
    this.name = 'LLMProviderError';
  }
}

/**
 * Flow execution error
 */
export class FlowExecutionError extends SDKError {
  constructor(
    message: string,
    public readonly flowCode?: string,
    public readonly step?: string,
    public readonly cause?: Error
  ) {
    super(message, 'FLOW_EXECUTION_ERROR');
    this.name = 'FlowExecutionError';
  }
}

/**
 * Configuration error
 */
export class ConfigurationError extends SDKError {
  constructor(message: string, public readonly field?: string) {
    super(message, 'CONFIGURATION_ERROR');
    this.name = 'ConfigurationError';
  }
}

/**
 * Validation error
 */
export class ValidationError extends SDKError {
  constructor(
    message: string,
    public readonly errors?: Record<string, string[]>
  ) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

/**
 * Timeout error
 */
export class TimeoutError extends SDKError {
  constructor(
    message: string,
    public readonly timeoutMs?: number,
    public readonly operation?: string
  ) {
    super(message, 'TIMEOUT_ERROR');
    this.name = 'TimeoutError';
  }
}

/**
 * Rate limit error
 */
export class RateLimitError extends SDKError {
  constructor(
    message: string,
    public readonly retryAfter?: number,
    public readonly limit?: number
  ) {
    super(message, 'RATE_LIMIT_ERROR');
    this.name = 'RateLimitError';
  }
}

/**
 * Check if error is retryable
 */
export function isRetryableError(error: Error): boolean {
  if (error instanceof RateLimitError) {
    return true;
  }

  if (error instanceof LLMProviderError) {
    // Retry on 5xx errors and some 4xx errors
    if (error.statusCode) {
      return (
        error.statusCode >= 500 ||
        error.statusCode === 408 || // Request Timeout
        error.statusCode === 429 // Too Many Requests
      );
    }
    return true;
  }

  if (error instanceof TimeoutError) {
    return true;
  }

  return false;
}

/**
 * Check if error is a network error
 */
export function isNetworkError(error: Error): boolean {
  const networkErrorMessages = [
    'econnrefused',
    'enotfound',
    'etimedout',
    'econnreset',
    'network',
    'fetch failed',
  ];

  const message = error.message.toLowerCase();
  return networkErrorMessages.some((msg) => message.includes(msg.toLowerCase()));
}

/**
 * Extract retry delay from error (for rate limiting)
 */
export function getRetryDelay(error: Error): number | undefined {
  if (error instanceof RateLimitError && error.retryAfter) {
    return error.retryAfter * 1000; // Convert to ms
  }

  if (error instanceof LLMProviderError) {
    // Some providers send retry-after in seconds
    if (error.statusCode === 429) {
      return 60000; // Default 1 minute for rate limits
    }
  }

  return undefined;
}

/* ------------------------------------------------------------------------
 * LOU-T4: unified provider.generate() failure compaction
 *
 * 12-factor-agents Factor 9 ("Compact errors into the context window")
 * scored Partial in the SDK audit: AgentExecutor.executeToolCall() (and
 * resume.ts's mirror of it) already compact a THROWN TOOL-CALL error into a
 * small `{error: message}` tool-result message - but a failed
 * `provider.generate()` call (rate limit, timeout, context-length-exceeded,
 * auth failure, ...) had no equivalent contract: it propagated however the
 * specific 'ai'-SDK-backed adapter (OpenAIProvider/AnthropicProvider/
 * OllamaProvider/OpenRouterProvider - see src/providers/*.ts, all four are
 * thin wrappers around the same `generateText()`/`streamText()` from the
 * 'ai' package) happened to throw it - a raw AI-SDK error object, complete
 * with request/response bodies, full stack, etc.
 *
 * compactProviderError() below is the shared mapping from "whatever the
 * 'ai' SDK actually throws" to a small, five-category, token-budget-
 * conscious shape. It is deliberately the SAME FAMILY as the tool-error
 * `{error: message}` pattern (a small object keyed by `error`), not a
 * different shape that would confuse a consumer switching between the two
 * error classes - see CompactedProviderError.error below.
 * ---------------------------------------------------------------------- */

/**
 * The failure categories a provider.generate() call can be bucketed into.
 * Each implies materially different caller handling, which is the whole
 * reason to distinguish them instead of collapsing everything into one
 * generic "provider failed" bucket:
 *
 * - 'rate-limit': the provider is throttling this caller. Handling:
 *   retry-with-backoff (ideally honoring `retryAfterMs` when present).
 * - 'timeout': the request didn't complete in time (a network timeout, an
 *   aborted fetch, ...). Handling: retry, possibly with a longer timeout.
 * - 'context-length-exceeded': the request itself is too large for the
 *   model's context window. Handling: truncate/summarize history and
 *   retry - retrying the SAME request verbatim will never succeed.
 * - 'auth-failure': bad/missing/revoked API key, or a 401/403 response.
 *   Handling: fail immediately and surface to a human - no amount of
 *   retrying or context-shrinking fixes an invalid credential.
 * - 'unknown': anything this mapping doesn't recognize. Handling: treated
 *   conservatively (see `retryable` below) since we have no real evidence
 *   of what actually went wrong.
 */
export type CompactedProviderErrorCategory =
  | 'rate-limit'
  | 'timeout'
  | 'context-length-exceeded'
  | 'auth-failure'
  | 'unknown';

/**
 * The compacted, token-budget-conscious shape a provider.generate() failure
 * is reduced to. Deliberately small: no request/response bodies, no stack
 * trace, no provider-SDK-internal fields - just enough for a caller (or,
 * for the categories AgentExecutor surfaces into `messages`, the model
 * itself) to decide how to react.
 *
 * `error` (not `message`) is the key name on purpose - it mirrors the
 * existing tool-error compaction shape (`{error: (error as Error).message}`,
 * see resume.ts and AgentExecutor.doExecuteToolCall()) so a consumer
 * switching between "a tool failed" and "the provider call failed" sees the
 * same recognizable `{error: string, ...}` family, not two unrelated shapes.
 */
export interface CompactedProviderError {
  /** Short, human/model-readable description of what went wrong. */
  error: string;
  category: CompactedProviderErrorCategory;
  /**
   * True when retrying (the same or a lightly-adjusted request) is a
   * reasonable thing to do - a caller's or model's actual retry policy is
   * its own business, this is just the compacted signal it decides from.
   */
  retryable: boolean;
  /** The `LLMProvider.name` that threw, when known (e.g. 'openai'). */
  providerName?: string;
  /** HTTP status code, when the underlying failure was an API call error. */
  statusCode?: number;
  /** Suggested backoff, in ms, when the provider communicated one (e.g. a `Retry-After` response header on a 429). */
  retryAfterMs?: number;
}

/** Hard cap on `CompactedProviderError.error` length - keeps the compacted
 * form small even if a provider's raw message (or response body text we
 * fall back to scanning) is unusually long. */
const MAX_COMPACTED_MESSAGE_LENGTH = 500;

function truncateMessage(message: string): string {
  if (message.length <= MAX_COMPACTED_MESSAGE_LENGTH) {
    return message;
  }
  return `${message.slice(0, MAX_COMPACTED_MESSAGE_LENGTH)}... (truncated)`;
}

// Pattern-based fallbacks for when the failure isn't a typed 'ai'-SDK error
// (e.g. ollama-ai-provider surfacing a raw fetch/network error, or a
// provider returning a 200 with an error payload the SDK doesn't model).
// These are intentionally permissive substring/regex checks over the
// message text - a false negative here just falls through to 'unknown',
// which is the safe (reject-to-caller) default; there is no false-positive
// cost that would make retryable/actionable categories fire spuriously
// often enough to matter for this text.
const CONTEXT_LENGTH_PATTERN =
  /context.length|context.window|context_length_exceeded|maximum context|max(?:imum)? tokens|too many tokens|reduce the length|prompt is too long/i;
const TIMEOUT_PATTERN = /\btimed?.?out\b|\betimedout\b|\babort(ed)?\b/i;
const RATE_LIMIT_PATTERN = /rate.?limit|too many requests/i;
const AUTH_PATTERN =
  /unauthorized|invalid api key|incorrect api key|authentication|api key.*(missing|invalid|not found)|\bforbidden\b/i;

/** Best-effort extraction of a `Retry-After`-style header value (seconds or
 * an HTTP-date) from an APICallError's response headers, converted to ms. */
function extractRetryAfterMs(err: APICallError): number | undefined {
  const header =
    err.responseHeaders?.['retry-after'] ?? err.responseHeaders?.['Retry-After'];
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(header);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

function categorizeMessage(message: string): {
  category: CompactedProviderErrorCategory;
  retryable: boolean;
} | undefined {
  if (AUTH_PATTERN.test(message)) {
    return { category: 'auth-failure', retryable: false };
  }
  if (RATE_LIMIT_PATTERN.test(message)) {
    return { category: 'rate-limit', retryable: true };
  }
  if (TIMEOUT_PATTERN.test(message)) {
    return { category: 'timeout', retryable: true };
  }
  if (CONTEXT_LENGTH_PATTERN.test(message)) {
    return { category: 'context-length-exceeded', retryable: false };
  }
  return undefined;
}

function categorizeApiCallError(err: APICallError): {
  category: CompactedProviderErrorCategory;
  retryable: boolean;
} {
  const status = err.statusCode;
  const text = `${err.message} ${err.responseBody ?? ''}`.toLowerCase();

  if (status === 401 || status === 403) {
    return { category: 'auth-failure', retryable: false };
  }
  if (status === 429) {
    return { category: 'rate-limit', retryable: true };
  }
  if (status === 408) {
    return { category: 'timeout', retryable: true };
  }
  // A 400 whose body/message reads as "your prompt is too big" is a
  // context-length-exceeded failure, not a generic bad-request - real
  // providers (OpenAI, Anthropic) both report this as a 400 with wording
  // matched by CONTEXT_LENGTH_PATTERN rather than a dedicated status code.
  if (status === 400 && CONTEXT_LENGTH_PATTERN.test(text)) {
    return { category: 'context-length-exceeded', retryable: false };
  }

  const byMessage = categorizeMessage(text);
  if (byMessage) {
    return byMessage;
  }

  // Fall back to the 'ai' SDK's own isRetryable classification (it marks
  // 5xx/408/429 as retryable when constructing APICallError) rather than
  // guessing further - this is real signal the SDK computed for us.
  return { category: 'unknown', retryable: err.isRetryable };
}

/**
 * Compact ANY error thrown by `LLMProvider.generate()` into a small,
 * five-category `CompactedProviderError`.
 *
 * Grounded in what OpenAIProvider.ts / AnthropicProvider.ts /
 * OllamaProvider.ts / OpenRouterProvider.ts actually do: all four are thin
 * wrappers around the same `generateText()` from the 'ai' package (Ollama
 * via 'ollama-ai-provider', OpenRouter via '@ai-sdk/openai' pointed at a
 * different baseURL, but both still go through 'ai' SDK's `generateText`),
 * so all four throw from the SAME small family of typed errors exported by
 * '@ai-sdk/provider' (re-exported from 'ai'):
 *
 * - `APICallError` - by far the common case: any non-2xx HTTP response from
 *   the provider's API (rate limits, auth failures, bad requests including
 *   context-length-exceeded, 5xx). Carries `statusCode`, `responseBody`,
 *   `responseHeaders`, and the SDK's own `isRetryable` classification.
 * - `LoadAPIKeyError` - thrown client-side, before any HTTP call, when no
 *   API key was configured (e.g. `OPENAI_API_KEY` unset with no `apiKey`
 *   passed to the provider config).
 * - `RetryError` - thrown when the 'ai' SDK's OWN internal retry loop gives
 *   up; its `.lastError` is the real underlying failure (typically another
 *   `APICallError`), which this function unwraps to.
 *
 * Ollama specifically can also throw a plain network error (e.g.
 * `ECONNREFUSED` when no local Ollama daemon is running) that never makes
 * it into an `APICallError` at all - `categorizeMessage()`'s pattern
 * fallback (plus the existing `isNetworkError()` helper) is what catches
 * that case and buckets it as a retryable 'timeout' rather than 'unknown'.
 */
export function compactProviderError(
  error: unknown,
  providerName?: string
): CompactedProviderError {
  // Unwrap the 'ai' SDK's own internal-retry-loop-exhausted wrapper to the
  // real failure underneath, so callers see (e.g.) 'rate-limit' instead of
  // an opaque 'unknown' RetryError.
  let cause: unknown = error;
  if (RetryError.isInstance(cause) && cause.lastError !== undefined) {
    cause = cause.lastError;
  }

  if (APICallError.isInstance(cause)) {
    const { category, retryable } = categorizeApiCallError(cause);
    return {
      error: truncateMessage(cause.message),
      category,
      retryable,
      providerName,
      statusCode: cause.statusCode,
      retryAfterMs: category === 'rate-limit' ? extractRetryAfterMs(cause) : undefined,
    };
  }

  if (LoadAPIKeyError.isInstance(cause)) {
    return {
      error: truncateMessage(cause.message),
      category: 'auth-failure',
      retryable: false,
      providerName,
    };
  }

  const message = cause instanceof Error ? cause.message : String(cause);

  if (cause instanceof Error && isNetworkError(cause)) {
    // A bare network failure (connection refused/reset, DNS failure, ...)
    // is transient in the same sense a timeout is - the request never even
    // reached the provider, so it's worth retrying.
    return {
      error: truncateMessage(message),
      category: 'timeout',
      retryable: true,
      providerName,
    };
  }

  const byMessage = categorizeMessage(message);
  if (byMessage) {
    return { error: truncateMessage(message), ...byMessage, providerName };
  }

  return {
    error: truncateMessage(message),
    category: 'unknown',
    retryable: false,
    providerName,
  };
}

/**
 * Categories AgentExecutor is willing to surface into `messages` for the
 * model to see and react to, rather than rejecting `execute()` outright -
 * see the design note above `AgentExecutor.runAgentLoop()`'s
 * `provider.generate()` call site for the full reasoning. Exported so a
 * consumer building its own execution loop (or inspecting a caught
 * `CompactedLLMProviderError`) can reuse the same classification instead of
 * re-deriving it from `category` by hand.
 */
export function isModelActionableProviderErrorCategory(
  category: CompactedProviderErrorCategory
): boolean {
  return (
    category === 'rate-limit' ||
    category === 'timeout' ||
    category === 'context-length-exceeded'
  );
}

/**
 * The error AgentExecutor.execute() rejects with for a provider.generate()
 * failure that is NOT surfaced into `messages` (see
 * `isModelActionableProviderErrorCategory()`), or for any provider failure
 * at all when `ExecuteOptions.surfaceRetryableProviderErrors` is left at
 * its default (`false`).
 *
 * Extends the SDK's existing `LLMProviderError` (rather than introducing an
 * unrelated error class) so `instanceof LLMProviderError` checks a caller
 * may already have keep working, and `.providerName`/`.statusCode` stay in
 * their existing places - `.message` is now the COMPACTED message (short,
 * no response body/stack) instead of whatever the raw 'ai'-SDK error
 * happened to stringify to, and the original error is always available via
 * `.cause`. `.compacted` carries the full `CompactedProviderError` (category,
 * retryable, retryAfterMs) for a caller that wants to branch on it.
 */
export class CompactedLLMProviderError extends LLMProviderError {
  constructor(public readonly compacted: CompactedProviderError, cause?: Error) {
    super(compacted.error, compacted.providerName, compacted.statusCode, cause);
    this.name = 'CompactedLLMProviderError';
  }
}
