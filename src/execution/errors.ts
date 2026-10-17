/**
 * Error Classes
 * Custom error types for SDK operations
 */

import { APICallError, JSONParseError, LoadAPIKeyError, RetryError, TypeValidationError } from 'ai';
import type { ErrorCode } from '../utils/errorCodes';
import type { ApprovalKind } from './ApprovalGate';
import { SDKError, type SDKErrorOptions } from '../utils/sdkError';
import { brandClass } from '../utils/brand';

// SDKError is defined in src/utils/sdkError.ts (no `ai` import, so browser code can use it).
export { SDKError, type SDKErrorOptions };

/**
 * Agent execution error
 */
export class AgentExecutionError extends SDKError {
  constructor(
    message: string,
    public readonly agentId?: string,
    public readonly cause?: Error
  ) {
    super(message, 'LOUSHO_AGENT_EXECUTION_FAILED');
    this.name = 'AgentExecutionError';
  }
}
brandClass(AgentExecutionError, 'AgentExecutionError');

/**
 * Tool execution error
 */
export class ToolExecutionError extends SDKError {
  constructor(
    message: string,
    public readonly toolName?: string,
    public readonly cause?: Error,
    code: ErrorCode = 'LOUSHO_TOOL_EXECUTION_FAILED'
  ) {
    super(message, code, { appendHelp: false });
    this.name = 'ToolExecutionError';
  }
}
brandClass(ToolExecutionError, 'ToolExecutionError');

/**
 * LLM provider error
 */
export class LLMProviderError extends SDKError {
  constructor(
    message: string,
    public readonly providerName?: string,
    public readonly statusCode?: number,
    public readonly cause?: Error,
    code: ErrorCode = 'LOUSHO_PROVIDER_REQUEST_FAILED'
  ) {
    super(message, code, { appendHelp: false });
    this.name = 'LLMProviderError';
  }
}
brandClass(LLMProviderError, 'LLMProviderError');

/**
 * Thrown by `AgentExecutor.execute()` when its `sessionId` names a
 * run that is paused awaiting a human approval. New input must not bypass
 * the pending decision: resolve it with `resumeAfterApproval()` first.
 *
 * @example
 * ```ts
 * try {
 *   await AgentExecutor.execute({ agent, input: 'hi', provider, sessionId, checkpointStore });
 * } catch (error) {
 *   if (error instanceof SessionAwaitingApprovalError) {
 *     console.log(`decide approval ${error.approvalId} first`);
 *   }
 * }
 * ```
 */
export class SessionAwaitingApprovalError extends SDKError {
  constructor(
    public readonly sessionId: string,
    public readonly approvalId: string | undefined,
    /** `'question'` when the pending approval is an `ask_question` call; absent for a tool approval or when unknown. */
    public readonly approvalKind?: ApprovalKind
  ) {
    super(
      `Session '${sessionId}' is paused awaiting approval${approvalId ? ` '${approvalId}'` : ''}, so execute() ` +
        'cannot add new input to it. Resolve the approval with resumeAfterApproval({ id: approvalId, approved: true }, ' +
        'approvalStore, toolRegistry, provider, options, checkpointStore) - passing the same checkpointStore so the ' +
        'session is marked as resumed - then call execute() again with your new input.',
      'LOUSHO_SESSION_AWAITING_APPROVAL'
    );
    this.name = 'SessionAwaitingApprovalError';
  }
}
brandClass(SessionAwaitingApprovalError, 'SessionAwaitingApprovalError');

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
    super(message, 'LOUSHO_FLOW_EXECUTION_FAILED');
    this.name = 'FlowExecutionError';
  }
}
brandClass(FlowExecutionError, 'FlowExecutionError');

/**
 * Configuration error
 */
export class ConfigurationError extends SDKError {
  constructor(message: string, public readonly field?: string, code: ErrorCode = 'LOUSHO_CONFIG_INVALID', options?: SDKErrorOptions) {
    super(message, code, options);
    this.name = 'ConfigurationError';
  }
}
brandClass(ConfigurationError, 'ConfigurationError');

/**
 * Validation error
 */
export class ValidationError extends SDKError {
  constructor(
    message: string,
    public readonly errors?: Record<string, string[]>,
    code: ErrorCode = 'LOUSHO_VALIDATION_FAILED'
  ) {
    super(message, code);
    this.name = 'ValidationError';
  }
}
brandClass(ValidationError, 'ValidationError');

/**
 * Timeout error
 */
export class TimeoutError extends SDKError {
  constructor(
    message: string,
    public readonly timeoutMs?: number,
    public readonly operation?: string
  ) {
    super(message, 'LOUSHO_OPERATION_TIMEOUT', { appendHelp: false });
    this.name = 'TimeoutError';
  }
}
brandClass(TimeoutError, 'TimeoutError');

/**
 * Rate limit error
 */
export class RateLimitError extends SDKError {
  constructor(
    message: string,
    public readonly retryAfter?: number,
    public readonly limit?: number
  ) {
    super(message, 'LOUSHO_PROVIDER_RATE_LIMITED', { appendHelp: false });
    this.name = 'RateLimitError';
  }
}
brandClass(RateLimitError, 'RateLimitError');

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
 * Unified provider.generate() failure compaction
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
 * - 'quota-exceeded': the account is out of quota or credits (OpenAI's
 *   `insufficient_quota` 429, a 402 such as OpenRouter's "Insufficient
 *   credits"). Handling: fail immediately - waiting does not add credit; a
 *   human must top up, or the caller falls back to another provider.
 * - 'auth-failure': bad/missing/revoked API key, or a 401/403 response.
 *   Handling: fail immediately and surface to a human - no amount of
 *   retrying or context-shrinking fixes an invalid credential.
 * - 'model-unloaded': a local server (LM Studio, Ollama) evicted the model
 *   or is still loading it. Handling: retry with a short backoff - the
 *   server loads it on demand or has already finished by the next attempt.
 * - 'unknown': anything this mapping doesn't recognize. Handling: treated
 *   conservatively (see `retryable` below) since we have no real evidence
 *   of what actually went wrong.
 */
export type CompactedProviderErrorCategory =
  | 'rate-limit'
  | 'timeout'
  | 'context-length-exceeded'
  | 'quota-exceeded'
  | 'auth-failure'
  | 'model-unloaded'
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
// `context.size` / `exceed_context_size` / `n_ctx`: llama.cpp and LM Studio
// ("request (N tokens) exceeds the available context size (M tokens)",
// "Context size has been exceeded."), sent as a 400, a 500 or an in-stream error.
const CONTEXT_LENGTH_PATTERN =
  /context.length|context.window|context_length_exceeded|context.size|exceed_context_size|\bn_ctx\b|maximum context|max(?:imum)? tokens|too many tokens|reduce the length|prompt is too long/i;
const TIMEOUT_PATTERN = /\btimed?.?out\b|\betimedout\b|\babort(ed)?\b/i;
// Billing, not throttling: waiting never helps. Deliberately narrow (a bare
// "quota" also appears in retryable per-minute limits).
const QUOTA_PATTERN = /insufficient_quota|exceeded your current quota|insufficient credits|payment required/i;
const RATE_LIMIT_PATTERN = /rate.?limit|too many requests/i;
// A local model that is not there to serve: LM Studio ("Model 'x' is not
// loaded", "model unloaded"), Ollama, llama.cpp. The server (re)loads on
// demand, so a short backoff is exactly what the failure wants.
const MODEL_UNLOADED_PATTERN =
  /\bmodel\b[^\n]{0,80}\b(unloaded|not loaded|isn't loaded|no longer loaded|still loading)\b|\bno model (is )?loaded\b|\bmodel_unloaded\b/i;
const AUTH_PATTERN =
  /unauthorized|invalid api key|incorrect api key|authentication|api key.*(missing|invalid|not found)|\bforbidden\b/i;

/** A response header by name, whatever its case. */
function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

/** Best-effort extraction of the server's wait hint, in ms, from an
 * APICallError's response headers: `retry-after-ms` (OpenAI, Azure) first,
 * then `Retry-After` (seconds or an HTTP-date). */
function extractRetryAfterMs(err: APICallError): number | undefined {
  const ms = Number(headerValue(err.responseHeaders, 'retry-after-ms'));
  if (headerValue(err.responseHeaders, 'retry-after-ms') && Number.isFinite(ms)) {
    return Math.max(0, ms);
  }
  const header = headerValue(err.responseHeaders, 'retry-after');
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    // A negative hint (a clock-skewed or broken server) means "now", never a negative wait.
    return Math.max(0, seconds * 1000);
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
  if (QUOTA_PATTERN.test(message)) {
    return { category: 'quota-exceeded', retryable: false };
  }
  if (RATE_LIMIT_PATTERN.test(message)) {
    return { category: 'rate-limit', retryable: true };
  }
  // Before the timeout check, in the same order as categorizeApiCallError(), so
  // one failure classifies the same via generate() and via a stream error chunk.
  if (CONTEXT_LENGTH_PATTERN.test(message)) {
    return { category: 'context-length-exceeded', retryable: false };
  }
  if (MODEL_UNLOADED_PATTERN.test(message)) {
    return { category: 'model-unloaded', retryable: true };
  }
  if (TIMEOUT_PATTERN.test(message)) {
    return { category: 'timeout', retryable: true };
  }
  return undefined;
}

/**
 * Whether a category read from an error's text agrees with its HTTP status:
 * "authentication" in a 5xx body ("authentication service unavailable") is a
 * server failure, not a bad key, and "aborted" in a 4xx body does not make a
 * rejected request a transient timeout.
 */
function messageFitsStatus(category: CompactedProviderErrorCategory, status: number | undefined): boolean {
  if (status === undefined) return true;
  if (category === 'auth-failure') return status < 500;
  if (category === 'timeout') return status >= 500;
  return true;
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
  // Before the 429 check: OpenAI sends an out-of-credit account as a 429.
  if (status === 402 || QUOTA_PATTERN.test(text)) {
    return { category: 'quota-exceeded', retryable: false };
  }
  if (status === 429) {
    return { category: 'rate-limit', retryable: true };
  }
  // A body/message that reads as "your prompt is too big" is a
  // context-length-exceeded failure whatever the status: OpenAI and Anthropic
  // send it as a 400, llama.cpp / LM Studio as a 500 on /responses. Checked
  // before the status fallbacks so a 5xx is not retried as transient.
  if (CONTEXT_LENGTH_PATTERN.test(text)) {
    return { category: 'context-length-exceeded', retryable: false };
  }
  // A 400/404/500 saying the model is not loaded is retryable whatever the
  // status: the server is still starting it or evicted it on idle.
  if (MODEL_UNLOADED_PATTERN.test(text)) {
    return { category: 'model-unloaded', retryable: true };
  }
  if (status === 408) {
    return { category: 'timeout', retryable: true };
  }

  const byMessage = categorizeMessage(text);
  if (byMessage && messageFitsStatus(byMessage.category, status)) {
    return byMessage;
  }

  // Fall back to the 'ai' SDK's own isRetryable classification (it marks
  // 5xx/408/429 as retryable when constructing APICallError) rather than
  // guessing further - this is real signal the SDK computed for us.
  return { category: 'unknown', retryable: err.isRetryable };
}

/** Network error codes (Node / undici) worth naming in the message. */
const NETWORK_CODE_TEXT: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ENOTFOUND: 'host not found',
  EAI_AGAIN: 'host lookup failed',
  ECONNRESET: 'connection reset',
  ETIMEDOUT: 'connection timed out',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  UND_ERR_CONNECT_TIMEOUT: 'connect timed out',
  UND_ERR_HEADERS_TIMEOUT: 'no response headers before the timeout',
  UND_ERR_BODY_TIMEOUT: 'response body timed out',
  UND_ERR_SOCKET: 'socket closed',
};

/** The first known network `code` along an error's `cause` chain (and an
 * AggregateError's `errors`), e.g. `ECONNREFUSED` under the 'ai' SDK's
 * "Cannot connect to API: " APICallError. */
function findNetworkCode(error: unknown, depth = 0): string | undefined {
  if (depth > 6 || typeof error !== 'object' || error === null) return undefined;
  const { code, cause, errors } = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof code === 'string' && Object.hasOwn(NETWORK_CODE_TEXT, code)) return code;
  for (const inner of Array.isArray(errors) ? errors : []) {
    const found = findNetworkCode(inner, depth + 1);
    if (found) return found;
  }
  return findNetworkCode(cause, depth + 1);
}

/** Messages of a dropped connection that carry no `code` (undici's bare `TypeError: terminated`, "other side closed"). */
const TRANSPORT_DROP_PATTERN = /^terminated$|socket (?:hang up|closed)|other side closed|premature close/i;

/** Whether `error` or anything on its `cause` chain is a dropped connection by message alone. */
function isTransportDrop(error: unknown, depth = 0): boolean {
  if (depth > 6 || typeof error !== 'object' || error === null) return false;
  const { message, cause } = error as { message?: unknown; cause?: unknown };
  return (typeof message === 'string' && TRANSPORT_DROP_PATTERN.test(message.trim())) || isTransportDrop(cause, depth + 1);
}

/**
 * Whether `error` or its `cause` chain is the 'ai' SDK failing to parse or
 * validate a provider's response (garbage or truncated SSE JSON): the
 * response was malformed, not the request. Matches by `name` too, so an error
 * from another copy of the SDK still counts.
 */
function isMalformedResponse(error: unknown, depth = 0): boolean {
  if (depth > 6 || typeof error !== 'object' || error === null) return false;
  if (JSONParseError.isInstance(error) || TypeValidationError.isInstance(error)) return true;
  const { name, cause } = error as { name?: unknown; cause?: unknown };
  return name === 'AI_JSONParseError' || name === 'AI_TypeValidationError' || isMalformedResponse(cause, depth + 1);
}

/** The request URL without query string or credentials (a key may ride in `?key=`). */
function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/** "Cannot connect to API: connection refused (ECONNREFUSED) at <url> - is the server running?" */
function networkMessage(message: string, code: string, url: string | undefined): string {
  const base = message.replace(/:\s*$/, '');
  const where = url ? ` at ${url}` : '';
  const hint =
    code === 'ECONNREFUSED' ? ' - is the server running?' : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? ' - check the base URL' : '';
  const detail = `${NETWORK_CODE_TEXT[code]} (${code})${where}${hint}`;
  return base ? `${base}: ${detail}` : detail;
}

/** Any thrown value as text. A non-Error (e.g. an object-valued stream error
 * chunk) gives its `message`, a nested `error.message` / string `error`, or
 * else its JSON - never "[object Object]". */
function describeThrown(value: unknown, depth = 0): string {
  if (value instanceof Error) return value.message;
  if (typeof value !== 'object' || value === null) return String(value);
  const { message, error } = value as { message?: unknown; error?: unknown };
  if (typeof message === 'string' && message) return message;
  if (typeof error === 'string' && error) return error;
  if (typeof error === 'object' && error !== null && depth < 3) return describeThrown(error, depth + 1);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A bare HTTP status phrase ("Bad Request"): what the 'ai' SDK uses as the
 * message when it cannot parse the provider's error body. Also OpenRouter's
 * generic "Provider returned error", whose body carries the upstream reason. */
const STATUS_TEXT_PATTERN =
  /^(?:bad request|unauthorized|payment required|forbidden|not found|method not allowed|not acceptable|request timeout|conflict|gone|payload too large|content too large|unprocessable (?:entity|content)|too many requests|internal server error|not implemented|bad gateway|service unavailable|gateway timeout|provider returned error)$/i;
const MAX_BODY_SNIPPET_LENGTH = 300;

/** The APICallError's message, plus a snippet of `responseBody` when the
 * message is only a status phrase (the body then holds the real reason).
 * The body is the provider's response, so no request headers can leak. */
function apiCallErrorMessage(err: APICallError): string {
  const message = err.message.trim();
  const body = err.responseBody?.replace(/\s+/g, ' ').trim();
  if (!body || body === message || !STATUS_TEXT_PATTERN.test(message)) {
    return err.message;
  }
  const snippet = body.length > MAX_BODY_SNIPPET_LENGTH ? `${body.slice(0, MAX_BODY_SNIPPET_LENGTH)}...` : body;
  return `${message}: ${snippet}`;
}

/**
 * The real failure under the 'ai' SDK's wrappers: a `RetryError`'s last error,
 * and the failure inside `@ai-sdk/provider-utils` 4+'s "Failed to process
 * successful response" (status 200) around a body-read error - such as the
 * in-response failure providerFetch raises.
 */
function underlyingFailure(error: unknown): unknown {
  let cause: unknown = RetryError.isInstance(error) && error.lastError !== undefined ? error.lastError : error;
  while (APICallError.isInstance(cause) && (cause.statusCode ?? 0) < 400 && APICallError.isInstance(cause.cause)) {
    cause = cause.cause;
  }
  return cause;
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
  const cause = underlyingFailure(error);

  // A connection failure (refused, DNS, reset, headers timeout) keeps its code
  // in the `cause` chain: name it and the URL. Transient like a timeout.
  const networkCode = findNetworkCode(cause);
  if (networkCode) {
    const apiCall = APICallError.isInstance(cause) ? cause : undefined;
    return {
      error: truncateMessage(networkMessage(describeThrown(cause), networkCode, safeUrl(apiCall?.url))),
      category: 'timeout',
      retryable: true,
      providerName,
      statusCode: apiCall?.statusCode,
    };
  }

  if (APICallError.isInstance(cause)) {
    const { category, retryable } = categorizeApiCallError(cause);
    return {
      error: truncateMessage(apiCallErrorMessage(cause)),
      category,
      retryable,
      providerName,
      statusCode: cause.statusCode,
      retryAfterMs: category === 'rate-limit' || cause.statusCode === 503 ? extractRetryAfterMs(cause) : undefined,
    };
  }

  // A response cut off by the connection, or garbage the SDK could not parse:
  // transient, the next attempt gets a fresh response. (withRetry() retries a
  // stream only while nothing has been emitted.)
  if (isTransportDrop(cause) || isMalformedResponse(cause)) {
    return {
      error: truncateMessage(describeThrown(cause)),
      category: 'unknown',
      retryable: true,
      providerName,
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

  const message = describeThrown(cause);

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
 * True for a cancellation, i.e. an error named `AbortError`: what
 * `fetch()`/`AbortSignal` throw on `controller.abort()`, what the 'ai' SDK
 * rethrows untouched for an aborted request, and what a caller-supplied
 * provider wrapper throws to stop a run between steps.
 *
 * A cancellation is NOT a provider failure, so AgentExecutor never compacts
 * it into a `CompactedLLMProviderError` (that would hide the error's
 * identity from the caller that requested the abort) and never folds it
 * into `messages` for a retry (TIMEOUT_PATTERN above would otherwise
 * bucket "This operation was aborted" as a retryable 'timeout'). A timeout
 * implemented via `AbortSignal.timeout()` throws a `TimeoutError` instead,
 * so it is still compacted as before.
 *
 * @example
 * ```ts
 * try {
 *   await AgentExecutor.execute({ agent, input, provider });
 * } catch (error) {
 *   if (isAbortError(error)) return; // the run was stopped on purpose
 *   throw error;
 * }
 * ```
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * True for a record/replay cassette failure: a replay mismatch
 * (`CassetteMismatchError`) or an unreadable cassette - both carry
 * `LOUSHO_CASSETTE_INVALID` (docs/errors.md). These are test-fixture
 * failures, not provider failures, so AgentExecutor must NOT compact them
 * into a `CompactedLLMProviderError`: the caller needs the typed error (its
 * cassette path, call number and the re-record hint) to know the cassette
 * has to be re-recorded. The name check covers a `CassetteMismatchError`
 * from another loaded copy of the SDK.
 */
export function isCassetteError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'CassetteMismatchError' ||
      (error instanceof SDKError && error.code === 'LOUSHO_CASSETTE_INVALID'))
  );
}

/**
 * Categories AgentExecutor is willing to surface into `messages` for the
 * model to see and react to, rather than rejecting `execute()` outright -
 * see the design note on `providerErrorMessage()` (generateStep.ts) for
 * the full reasoning. Exported so a
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

/** Codes of a provider's own refusal before any request, which {@link CompactedLLMProviderError} keeps. */
const OWN_PROVIDER_CODES: readonly ErrorCode[] = ['LOUSHO_PROVIDER_MISSING_API_KEY', 'LOUSHO_PEER_MISSING'];

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
    // A throttled call (`rate-limit`, e.g. a 429) has its own code, as does a provider that refused to call without
    // an API key, or whose package is not installed (it says so before any request); every other failure is a failed request.
    const ownCode = cause instanceof SDKError ? OWN_PROVIDER_CODES.find((c) => c === cause.code) : undefined;
    const code: ErrorCode = ownCode ?? (compacted.category === 'rate-limit' ? 'LOUSHO_PROVIDER_RATE_LIMITED' : 'LOUSHO_PROVIDER_REQUEST_FAILED');
    super(compacted.error, compacted.providerName, compacted.statusCode, cause, code);
    this.name = 'CompactedLLMProviderError';
  }
}
brandClass(CompactedLLMProviderError, 'CompactedLLMProviderError');
