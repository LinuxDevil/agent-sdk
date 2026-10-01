/**
 * Provider resilience (LOU-V7.1): retry and model-fallback wrappers that
 * turn any `LLMProvider` into another `LLMProvider`, so they compose with
 * each other and work anywhere a provider is accepted.
 *
 * Retryability comes from the SDK's provider-error classification
 * (`compactProviderError()` in execution/errors.ts), not a second rule set.
 * The older generic `retry()` helper (execution/retry.ts) is deliberately
 * not reused: its backoff sleep ignores the abort signal, its delay hint
 * reads only the legacy `RateLimitError`, and its default classification
 * retries any `LLMProviderError` without a status code (auth failures
 * included).
 */

import type { GenerateOptions, LLMProvider, LLMProviderConfig } from './llm';
import { abortableDelay } from './abortableDelay';
import {
  CompactedLLMProviderError,
  ConfigurationError,
  compactProviderError,
  isAbortError,
  type CompactedProviderError,
} from '../execution/errors';

/** Exponential backoff between retries. */
export interface BackoffOptions {
  /** Delay before the first retry, in ms. Default 500. */
  initialMs?: number;
  /** Upper bound for the computed delay, in ms. Default 30_000. */
  maxMs?: number;
  /** Multiplier applied per retry. Default 2. */
  factor?: number;
  /** Randomize each delay to 50-100% of its value. Default true. */
  jitter?: boolean;
}

/** Passed to `WithRetryOptions.onRetry` before each backoff wait. */
export interface RetryInfo {
  /** The attempt that just failed (1 = the first call). */
  attempt: number;
  error: unknown;
  /** How long the wrapper waits before the next attempt. */
  delayMs: number;
}

export interface WithRetryOptions {
  /** Retries after the first attempt. Default 2 (so at most 3 calls). */
  maxRetries?: number;
  backoff?: BackoffOptions;
  /** Whether a failure is retried. Default `isRetryableProviderError`. */
  retryOn?: (error: unknown, attempt: number) => boolean;
  onRetry?: (info: RetryInfo) => void;
  /** Stops retrying (and aborts the in-flight call) once aborted; the call's own `signal` does the same. */
  signal?: AbortSignal;
  /** Per-attempt time limit in ms (for `stream()` it also bounds reading the stream); a timed-out attempt is retryable. */
  timeoutMs?: number;
}

/** The compacted classification of a provider failure. */
function classify(error: unknown): CompactedProviderError {
  return error instanceof CompactedLLMProviderError ? error.compacted : compactProviderError(error);
}

/**
 * Default retry rule: rate limits, timeouts, network failures and 5xx
 * responses are retryable; auth failures, invalid requests and
 * context-length errors are not, and neither is a cancellation.
 */
export function isRetryableProviderError(error: unknown): boolean {
  return !isAbortError(error) && classify(error).retryable;
}

function backoffDelay(error: unknown, attempt: number, backoff: BackoffOptions = {}): number {
  const retryAfterMs = classify(error).retryAfterMs;
  if (retryAfterMs !== undefined) {
    return retryAfterMs;
  }
  const { initialMs = 500, maxMs = 30_000, factor = 2, jitter = true } = backoff;
  const delay = Math.min(initialMs * factor ** (attempt - 1), maxMs);
  return Math.round(jitter ? delay * (0.5 + Math.random() / 2) : delay);
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return present.length > 1 ? AbortSignal.any(present) : present[0];
}

async function callWithRetry<T>(
  call: GenerateOptions,
  attempt: (call: GenerateOptions) => Promise<T>,
  options: WithRetryOptions
): Promise<T> {
  const { maxRetries = 2, retryOn = isRetryableProviderError, onRetry, timeoutMs } = options;
  const signal = combineSignals(options.signal, call.signal);
  for (let n = 1; ; n++) {
    signal?.throwIfAborted();
    const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    try {
      return await attempt({ ...call, signal: combineSignals(signal, timeout) });
    } catch (error) {
      if (n > maxRetries || signal?.aborted || isAbortError(error) || !retryOn(error, n)) {
        throw error;
      }
      const delayMs = backoffDelay(error, n, options.backoff);
      onRetry?.({ attempt: n, error, delayMs });
      await abortableDelay(delayMs, signal);
    }
  }
}

/**
 * Retry a provider's `generate()` and `stream()` on transient failures, with
 * exponential backoff that honors a provider's `retryAfterMs` hint. A
 * `stream()` call is retried only when it rejects; an error delivered inside
 * an already-returned stream is not, since part of it may have been consumed.
 *
 * @example
 * ```ts
 * const provider = withRetry(resolveProvider('openai/gpt-4o-mini'), { maxRetries: 3 });
 * ```
 */
export function withRetry(provider: LLMProvider, options: WithRetryOptions = {}): LLMProvider {
  return {
    get name() {
      return provider.name;
    },
    get defaultModel() {
      return provider.defaultModel;
    },
    generate: (call) => callWithRetry(call, (attempt) => provider.generate(attempt), options),
    stream: (call) => callWithRetry(call, (attempt) => provider.stream(attempt), options),
    supportsTools: (model) => provider.supportsTools(model),
    supportsStreaming: (model) => provider.supportsStreaming(model),
    getModels: () => provider.getModels(),
  };
}

/**
 * `withRetry()` configured from a provider config's `maxRetries` and
 * `timeout` (ms per attempt), the two `LLMProviderConfig` fields the
 * built-in providers do not read themselves.
 */
export function resilientProvider(
  provider: LLMProvider,
  config: Pick<LLMProviderConfig, 'maxRetries' | 'timeout'>
): LLMProvider {
  return withRetry(provider, { maxRetries: config.maxRetries, timeoutMs: config.timeout });
}

/** Passed to `WithFallbackOptions.onFallback` when the next provider takes over. */
export interface FallbackInfo {
  from: string;
  to: string;
  error: unknown;
}

export interface WithFallbackOptions {
  /** Whether a failure moves on to the next provider. Default: any failure except a cancellation. */
  fallbackOn?: (error: unknown) => boolean;
  onFallback?: (info: FallbackInfo) => void;
}

/**
 * Try each provider in order until one succeeds; every call starts with the
 * first. Rethrows the last error when all fail. `name` and `defaultModel`
 * report the provider that served (or is serving) the latest call;
 * `supportsTools`, `supportsStreaming` and `getModels` ask the first.
 *
 * A call's `model` goes only to the first provider, and only when it differs
 * from this wrapper's `defaultModel`; otherwise, and always for fallbacks,
 * each provider uses its own `defaultModel`.
 *
 * @example
 * ```ts
 * const provider = withFallback([
 *   withRetry(resolveProvider('openai/gpt-4o-mini')),
 *   withRetry(resolveProvider('anthropic/claude-3-5-haiku-latest')),
 * ]);
 * ```
 */
export function withFallback(providers: LLMProvider[], options: WithFallbackOptions = {}): LLMProvider {
  const [first] = providers;
  if (!first) {
    throw new ConfigurationError('withFallback() needs at least one provider', 'providers');
  }
  const { fallbackOn = (error: unknown) => !isAbortError(error), onFallback } = options;
  let active = first;

  async function run<T>(call: GenerateOptions, attempt: (provider: LLMProvider, call: GenerateOptions) => Promise<T>) {
    const model = call.model && call.model !== active.defaultModel ? call.model : undefined;
    let lastError: unknown;
    for (const [index, provider] of providers.entries()) {
      if (index > 0) {
        if (call.signal?.aborted || !fallbackOn(lastError)) {
          throw lastError;
        }
        onFallback?.({ from: active.name, to: provider.name, error: lastError });
      }
      active = provider;
      try {
        return await attempt(provider, { ...call, model: index === 0 ? model : undefined });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  return {
    get name() {
      return active.name;
    },
    get defaultModel() {
      return active.defaultModel;
    },
    generate: (call) => run(call, (provider, attempt) => provider.generate(attempt)),
    stream: (call) => run(call, (provider, attempt) => provider.stream(attempt)),
    supportsTools: (model) => first.supportsTools(model),
    supportsStreaming: (model) => first.supportsStreaming(model),
    getModels: () => first.getModels(),
  };
}
