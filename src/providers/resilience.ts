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

import type { GenerateOptions, LLMProvider, LLMProviderConfig, ServedBy, StreamChunk, StreamResult } from './llm';
import { abortableDelay } from './abortableDelay';
import { providerEventsOf } from './providerEvents';
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
  /** Per-attempt time limit in ms (for `stream()` it bounds establishing the stream, up to its first chunk); a timed-out attempt is retryable. */
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
  provider: LLMProvider,
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
      providerEventsOf(call)?.retry({ attempt: n, maxRetries, delayMs, error, provider: provider.name });
      await abortableDelay(delayMs, signal);
    }
  }
}

/** A stream() attempt opened far enough to know it works: the result and its first fullStream chunk. */
interface OpenedStream {
  streamed: StreamResult;
  iterator: AsyncIterator<StreamChunk>;
  first: IteratorResult<StreamChunk>;
  /** Who serves the stream: the stream's own `servedBy`, else what `withFallback()` sets. */
  servedBy?: ServedBy;
}

/** The final values of a discarded stream() attempt, marked read so they cannot reject unhandled. */
function silence(streamed: StreamResult): void {
  for (const value of [streamed.text, streamed.usage, streamed.finishReason, streamed.toolCalls]) {
    Promise.resolve(value).catch(() => undefined);
  }
}

/**
 * What a `stream()` attempt is: the `stream()` call plus pulling the stream's
 * first chunk. Streaming providers resolve `stream()` before the request
 * finishes and report its failure inside the returned stream, so both count
 * as the attempt's failure a retry or fallback answers. Once the first chunk
 * is out the attempt is committed: a later failure propagates unchanged,
 * since part of the stream may already have been consumed.
 */
async function openStream(provider: LLMProvider, call: GenerateOptions): Promise<OpenedStream> {
  const streamed = await provider.stream(call);
  const iterator = streamed.fullStream[Symbol.asyncIterator]();
  let first: IteratorResult<StreamChunk>;
  try {
    first = await iterator.next();
  } catch (error) {
    silence(streamed);
    throw error;
  }
  if (!first.done && first.value.type === 'error') {
    silence(streamed);
    throw first.value.error ?? new Error('The model stream reported an error without details');
  }
  return { streamed, iterator, first, servedBy: streamed.servedBy };
}

/** `opened` as the StreamResult of a committed attempt: its first chunk, then the rest of the stream. */
function streamResultOf({ streamed, iterator, first, servedBy }: OpenedStream): StreamResult {
  silence(streamed);
  const fullStream = (async function* (): AsyncGenerator<StreamChunk> {
    if (first.done) return;
    yield first.value;
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) yield next.value;
  })();
  return { ...streamed, fullStream, ...(servedBy && { servedBy }) };
}

/**
 * Retry a provider's `generate()` and `stream()` on transient failures, with
 * exponential backoff that honors a provider's `retryAfterMs` hint. A
 * `stream()` call is retried when establishing it fails - `stream()`
 * rejecting, or the stream failing (or reporting an `error` chunk) before it
 * yields its first chunk; an error after the first chunk is not retried,
 * since part of the stream may already have been consumed.
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
    generate: (call) => callWithRetry(provider, call, (attempt) => provider.generate(attempt), options),
    stream: (call) => callWithRetry(provider, call, (attempt) => openStream(provider, attempt), options).then(streamResultOf),
    supportsTools: (model) => provider.supportsTools(model),
    supportsStreaming: (model) => provider.supportsStreaming(model),
    getModels: () => provider.getModels(),
    // N1a: absent on the wrapped provider means no hosted tools.
    supportsHostedTool: (type) => provider.supportsHostedTool?.(type) ?? false,
  };
}

/**
 * `withRetry()` configured from a provider config's `maxRetries` and
 * `timeout` (ms per attempt). The built-in providers also pass
 * `maxRetries` to the `ai` SDK's own retries (LOU-V7.2), so build the
 * wrapped provider with `maxRetries: 0` to retry in one place.
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
 * first. Rethrows the last error when all fail. Each call keeps its own
 * fallback state, so concurrent calls never see each other's switches.
 * `name`, `defaultModel`, `supportsTools`, `supportsStreaming`, `getModels`
 * and `supportsHostedTool` are the first provider's; the provider and model
 * that served a call are on its result as `servedBy`, which the executor
 * books the call's usage and cost under.
 *
 * A `stream()` call falls back on the same boundary `withRetry()` retries on:
 * establishing the stream failing (up to its first chunk). A failure after
 * the first chunk propagates unchanged.
 *
 * A call's `model` goes only to the first provider, and only when it differs
 * from the first provider's `defaultModel`; otherwise, and always for
 * fallbacks, each provider uses its own `defaultModel`.
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

  async function run<T extends { servedBy?: ServedBy }>(
    call: GenerateOptions,
    attempt: (provider: LLMProvider, call: GenerateOptions) => Promise<T>
  ): Promise<T> {
    const model = call.model && call.model !== first.defaultModel ? call.model : undefined;
    let lastError: unknown;
    for (const [index, provider] of providers.entries()) {
      if (index > 0) {
        if (call.signal?.aborted || !fallbackOn(lastError)) {
          throw lastError;
        }
        const info: FallbackInfo = { from: providers[index - 1].name, to: provider.name, error: lastError };
        onFallback?.(info);
        providerEventsOf(call)?.fallback(info);
      }
      const sent = index === 0 ? model : undefined;
      try {
        const result = await attempt(provider, { ...call, model: sent });
        // A nested wrapper already knows which of its providers served.
        result.servedBy ??= { provider: provider.name, model: sent ?? provider.defaultModel };
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  return {
    get name() {
      return first.name;
    },
    get defaultModel() {
      return first.defaultModel;
    },
    generate: (call) => run(call, (provider, attempt) => provider.generate(attempt)),
    stream: async (call) => streamResultOf(await run(call, (provider, attempt) => openStream(provider, attempt))),
    supportsTools: (model) => first.supportsTools(model),
    supportsStreaming: (model) => first.supportsStreaming(model),
    getModels: () => first.getModels(),
    supportsHostedTool: (type) => first.supportsHostedTool?.(type) ?? false,
  };
}
