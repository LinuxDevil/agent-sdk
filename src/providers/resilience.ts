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
import { providerEventsOf, withRetriesOwned } from './providerEvents';
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
  /** Upper bound for the computed delay, in ms. Default 30_000. A server's `Retry-After` above it is not waited out: the call fails at once with `retryAfterMs` set. */
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
  /**
   * Per-attempt time limit in ms; a timed-out attempt is retryable. For
   * `stream()` it bounds only establishing the stream, up to its first chunk:
   * a stream that started is never cut off by it (use `idleTimeoutMs`).
   */
  timeoutMs?: number;
  /**
   * `stream()` only: the longest gap, in ms, between two chunks (and after the
   * first chunk). A stalled stream fails with a `TimeoutError`; it is retried
   * only while nothing but reasoning was out, like any stream failure.
   */
  idleTimeoutMs?: number;
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

/**
 * The wait before retry `attempt`. The server's hint (`retryAfterMs`) is the
 * delay when it fits under `backoff.maxMs`; a longer one is not waited out
 * (a `Retry-After: 3600` would stall the run for an hour): the failure is
 * thrown at once, carrying the hint as `compacted.retryAfterMs`.
 */
function backoffDelay(error: unknown, attempt: number, backoff: BackoffOptions = {}): number {
  const { initialMs = 500, maxMs = 30_000, factor = 2, jitter = true } = backoff;
  const compacted = classify(error);
  const retryAfterMs = compacted.retryAfterMs;
  if (retryAfterMs !== undefined) {
    if (retryAfterMs > maxMs) {
      throw error instanceof CompactedLLMProviderError
        ? error
        : new CompactedLLMProviderError(compacted, error instanceof Error ? error : undefined);
    }
    return retryAfterMs;
  }
  const delay = Math.min(initialMs * factor ** (attempt - 1), maxMs);
  return Math.round(jitter ? delay * (0.5 + Math.random() / 2) : delay);
}

/** The error an `AbortSignal.timeout()` aborts with. */
function timeoutError(message = 'The operation was aborted due to timeout'): Error {
  return new DOMException(message, 'TimeoutError');
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return present.length > 1 ? AbortSignal.any(present) : present[0];
}

/** One call's retry state: the attempts' call options, and the decision after each failure. */
interface Retrier {
  /** The options for the next attempt: the call (with its own `timeoutMs` unless `bounded` is false), marked as retried here. */
  attemptCall(bounded?: boolean): GenerateOptions;
  /** Rethrows `error` when it is not retried; otherwise reports the retry and waits out its backoff. */
  afterFailure(error: unknown): Promise<void>;
}

function retrierFor(provider: LLMProvider, call: GenerateOptions, options: WithRetryOptions): Retrier {
  const { maxRetries = 2, retryOn = isRetryableProviderError, onRetry, timeoutMs } = options;
  const signal = combineSignals(options.signal, call.signal);
  let failures = 0;
  return {
    attemptCall(bounded = true) {
      signal?.throwIfAborted();
      const timeout = timeoutMs === undefined || !bounded ? undefined : AbortSignal.timeout(timeoutMs);
      // C2: the 'ai' SDK's own retries are off for a call retried here.
      return withRetriesOwned({ ...call, signal: combineSignals(signal, timeout) });
    },
    async afterFailure(error) {
      const n = ++failures;
      if (n > maxRetries || signal?.aborted || isAbortError(error) || !retryOn(error, n)) {
        throw error;
      }
      const delayMs = backoffDelay(error, n, options.backoff);
      onRetry?.({ attempt: n, error, delayMs });
      providerEventsOf(call)?.retry({ attempt: n, maxRetries, delayMs, error, provider: provider.name });
      await abortableDelay(delayMs, signal);
    },
  };
}

async function callWithRetry<T>(
  retrier: Retrier,
  attempt: (call: GenerateOptions) => Promise<T>,
  bounded = true
): Promise<T> {
  for (;;) {
    try {
      return await attempt(retrier.attemptCall(bounded));
    } catch (error) {
      await retrier.afterFailure(error);
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
  /** Aborts this attempt's request (set by `withRetry()` for `idleTimeoutMs`). */
  abort?: (reason: unknown) => void;
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
 * as the attempt's failure a retry or fallback answers. For `withFallback()`
 * the attempt is committed once the first chunk is out: a later failure
 * propagates unchanged. `withRetry()` goes further (see `streamWithRetry()`).
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
 * C2: whether a chunk commits a stream attempt - it is output the consumer
 * acts on (text, a tool call or result, the finish). Reasoning chunks and an
 * empty text delta do not: a local runtime (LM Studio) sends an empty
 * `reasoning-end` before reporting a 500 as an error event.
 */
function commits(chunk: StreamChunk): boolean {
  if (chunk.type === 'text-delta') return Boolean(chunk.textDelta);
  return chunk.type !== 'reasoning-delta' && chunk.type !== 'reasoning-end' && chunk.type !== 'error';
}

/**
 * `withRetry()`'s `stream()`: an attempt is retried when establishing it
 * fails (see `openStream()`), and also when its stream fails after
 * uncommitted chunks only (reasoning, empty deltas; see `commits()`). Those
 * chunks were passed on as they came, so after a retry the consumer sees the
 * next attempt's chunks from the start, after the `provider.retry` event.
 * The result's `text`, `usage`, `finishReason`, `toolCalls` and
 * `textStream` are the latest attempt's.
 */
async function streamWithRetry(provider: LLMProvider, call: GenerateOptions, options: WithRetryOptions): Promise<StreamResult> {
  const retrier = retrierFor(provider, call, options);
  const { timeoutMs, idleTimeoutMs } = options;
  const firstChunkMs = timeoutMs ?? idleTimeoutMs;
  // PROV-F7: `timeoutMs` bounds opening the stream up to its first chunk only,
  // so the attempt's own controller (not a fixed `AbortSignal.timeout`) is
  // aborted by a timer that is cleared once the first chunk is in.
  const openBounded = async (attempt: GenerateOptions): Promise<OpenedStream> => {
    const controller = new AbortController();
    const timer =
      firstChunkMs === undefined ? undefined : setTimeout(() => controller.abort(timeoutError()), firstChunkMs);
    try {
      const opened = await openStream(provider, { ...attempt, signal: combineSignals(attempt.signal, controller.signal) });
      return { ...opened, abort: (reason) => controller.abort(reason) };
    } finally {
      clearTimeout(timer);
    }
  };
  const open = async () => {
    const opened = await callWithRetry(retrier, openBounded, false);
    silence(opened.streamed);
    return opened;
  };
  /** The next chunk, failing with a `TimeoutError` when it takes longer than `idleTimeoutMs`. */
  const pull = async (opened: OpenedStream): Promise<IteratorResult<StreamChunk>> => {
    if (idleTimeoutMs === undefined) return opened.iterator.next();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = timeoutError(`The stream was idle for ${idleTimeoutMs} ms`);
        opened.abort?.(error);
        reject(error);
      }, idleTimeoutMs);
    });
    try {
      return await Promise.race([opened.iterator.next(), idle]);
    } finally {
      clearTimeout(timer);
    }
  };
  let current = await open();
  let servedBy: ServedBy | undefined;
  /** Whether an `error` chunk's failure is retried; one that is not is passed on as the chunk. */
  const retried = (error: Error | undefined) =>
    retrier.afterFailure(error ?? new Error('The model stream reported an error without details')).then(
      () => true,
      (failure: unknown) => {
        if (isAbortError(failure)) throw failure;
        return false;
      }
    );
  const fullStream = (async function* (): AsyncGenerator<StreamChunk> {
    let committed = false;
    let next = current.first;
    while (!next.done) {
      const chunk = next.value;
      if (chunk.type === 'error' && !committed && (await retried(chunk.error))) {
        current = await open();
        next = current.first;
        continue;
      }
      committed ||= commits(chunk);
      yield chunk;
      try {
        next = await pull(current);
      } catch (error) {
        if (committed) throw error;
        await retrier.afterFailure(error);
        current = await open();
        next = current.first;
      }
    }
  })();
  return {
    fullStream,
    get textStream() {
      return current.streamed.textStream;
    },
    get text() {
      return current.streamed.text;
    },
    get usage() {
      return current.streamed.usage;
    },
    get finishReason() {
      return current.streamed.finishReason;
    },
    get toolCalls() {
      return current.streamed.toolCalls;
    },
    get servedBy() {
      return servedBy ?? current.servedBy;
    },
    set servedBy(value) {
      servedBy = value;
    },
  };
}

/**
 * Retry a provider's `generate()` and `stream()` on transient failures, with
 * exponential backoff that honors a provider's `retryAfterMs` hint. A
 * `stream()` call is retried when establishing it fails - `stream()`
 * rejecting, or the stream failing (or reporting an `error` chunk) before it
 * yields its first chunk - and when its stream fails before any output:
 * reasoning chunks and empty text deltas do not count. Reasoning already
 * passed on is followed by the next attempt's from the start. A failure after
 * text, a tool call or the finish is not retried, since that output may
 * already have been acted on.
 *
 * The wrapper is the only retry layer: the built-in providers send its calls
 * with the `ai` SDK's own retries off (`maxRetries: 0`), whatever their
 * config's `maxRetries`.
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
    generate: (call) => callWithRetry(retrierFor(provider, call, options), (attempt) => provider.generate(attempt)),
    stream: (call) => streamWithRetry(provider, call, options),
    supportsTools: (model) => provider.supportsTools(model),
    supportsStreaming: (model) => provider.supportsStreaming(model),
    getModels: () => provider.getModels(),
    // N1a: absent on the wrapped provider means no hosted tools.
    supportsHostedTool: (type) => provider.supportsHostedTool?.(type) ?? false,
  };
}

/**
 * `withRetry()` configured from a provider config's `maxRetries` and
 * `timeout` (ms per attempt). The wrapped provider's calls go out with the
 * `ai` SDK's own retries off (C2), so retries happen in one place.
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
