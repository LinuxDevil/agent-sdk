/**
 * Client-side rate limiting for model calls: `withRateLimit()`
 * turns any `LLMProvider` into one that queues its calls to stay under a
 * requests-per-minute, tokens-per-minute and in-flight cap, so sub-agent
 * fan-out, flow waves and eval suites cannot burst unbounded calls.
 *
 * The limiter is a plain object (`createRateLimiter()`), so one can be shared
 * by several providers or by a whole agent tree (`createAgent({ rateLimit })`).
 */

import type { GenerateOptions, LLMProvider, StreamChunk, StreamResult } from './llm';
import { estimateTokens } from '../models/estimateTokens';
import { delegateCapabilities } from './delegateCapabilities';
import { ConfigurationError } from '../execution/errors';
import { withProviderEvents } from './providerEvents';

/** Limits of a {@link RateLimiter}. Each one is optional; an unset limit is not enforced. */
export interface RateLimitOptions {
  /** Model calls started per rolling minute. */
  requestsPerMinute?: number;
  /**
   * Estimated tokens (prompt, tool definitions and `maxTokens`) per rolling
   * minute. A finished call is re-booked at its reported total, when it has
   * one. A single call larger than the limit still runs, alone in its window.
   */
  tokensPerMinute?: number;
  /** Model calls in flight at once. A stream counts until it is fully read. */
  maxConcurrent?: number;
}

/** A slot taken from a {@link RateLimiter}. */
export interface RateLimitLease {
  /**
   * Frees the slot (once). `actualTokens`, when given, replaces the call's
   * estimate in the tokens-per-minute window.
   */
  release(actualTokens?: number): void;
  /** Re-books the call at `actualTokens` (ignored when absent), keeping the slot. */
  adjust(actualTokens?: number): void;
}

const WINDOW_MS = 60_000;

interface Waiter {
  tokens: number;
  signal?: AbortSignal;
  resolve: (lease: RateLimitLease) => void;
  reject: (reason: unknown) => void;
  onAbort?: () => void;
}

interface Spend {
  at: number;
  tokens: number;
}

function assertLimit(name: string, value: number | undefined, integer = false): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new ConfigurationError(
      `withRateLimit: '${name}' must be a positive ${integer ? 'whole ' : ''}number, got ${String(value)}.`,
      name,
      'LOUSHO_CONFIG_INVALID'
    );
  }
}

/**
 * Admits calls first-in first-out while they fit the limits; `acquire()`
 * waits (and rejects with the signal's reason when aborted while waiting).
 */
export class RateLimiter {
  private readonly queue: Waiter[] = [];
  private starts: number[] = [];
  private spent: Spend[] = [];
  private active = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: RateLimitOptions = {}) {
    assertLimit('requestsPerMinute', options.requestsPerMinute);
    assertLimit('tokensPerMinute', options.tokensPerMinute);
    assertLimit('maxConcurrent', options.maxConcurrent, true);
  }

  /** Waits for a slot for a call of about `tokens` tokens. */
  acquire(tokens = 0, signal?: AbortSignal): Promise<RateLimitLease> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const waiter: Waiter = { tokens, signal, resolve, reject };
      if (signal) {
        waiter.onAbort = () => {
          const at = this.queue.indexOf(waiter);
          if (at >= 0) this.queue.splice(at, 1);
          reject(signal.reason);
          this.pump();
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      this.pump();
    });
  }

  /** Calls waiting for a slot. */
  get pending(): number {
    return this.queue.length;
  }

  /** Calls holding a slot. */
  get inFlight(): number {
    return this.active;
  }

  /** `undefined` when `tokens` fit now; else ms to wait (`Infinity`: until a slot is released). */
  private waitFor(tokens: number, now: number): number | undefined {
    const { requestsPerMinute, tokensPerMinute, maxConcurrent } = this.options;
    this.starts = this.starts.filter((at) => at > now - WINDOW_MS);
    this.spent = this.spent.filter((entry) => entry.at > now - WINDOW_MS);
    if (maxConcurrent !== undefined && this.active >= maxConcurrent) return Infinity;
    let wait = 0;
    if (requestsPerMinute !== undefined && this.starts.length >= requestsPerMinute) {
      wait = Math.max(wait, this.starts[this.starts.length - requestsPerMinute] + WINDOW_MS - now);
    }
    if (tokensPerMinute !== undefined && this.spent.length > 0) {
      let total = this.spent.reduce((sum, entry) => sum + entry.tokens, 0);
      for (const entry of this.spent) {
        if (total + tokens <= tokensPerMinute) break;
        total -= entry.tokens;
        wait = Math.max(wait, entry.at + WINDOW_MS - now);
      }
    }
    return wait > 0 ? wait : undefined;
  }

  private pump(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (;;) {
      const head = this.queue[0];
      if (!head) return;
      const now = Date.now();
      const wait = this.waitFor(head.tokens, now);
      if (wait !== undefined) {
        if (wait !== Infinity) this.timer = setTimeout(() => this.pump(), Math.max(1, Math.ceil(wait)));
        return;
      }
      this.queue.shift();
      if (head.onAbort) head.signal?.removeEventListener('abort', head.onAbort);
      head.resolve(this.take(head.tokens, now));
    }
  }

  /** A request started inside a held slot (a `withRetry()` retry): it counts against `requestsPerMinute`. */
  private bookStart(): void {
    this.starts.push(Date.now());
  }

  private take(tokens: number, now: number): RateLimitLease {
    this.active++;
    this.starts.push(now);
    const spend: Spend = { at: now, tokens };
    this.spent.push(spend);
    let released = false;
    const adjust = (actualTokens?: number) => {
      if (actualTokens !== undefined && Number.isFinite(actualTokens) && actualTokens >= 0) spend.tokens = actualTokens;
    };
    return {
      adjust,
      release: (actualTokens) => {
        adjust(actualTokens);
        if (released) return;
        released = true;
        this.active--;
        this.pump();
      },
    };
  }
}

/** A limiter to share between providers or agents. */
export function createRateLimiter(options: RateLimitOptions = {}): RateLimiter {
  return new RateLimiter(options);
}

/** What a call is estimated to cost against `tokensPerMinute`. */
function estimateCall(call: GenerateOptions): number {
  const tools = call.tools?.length ? estimateTokens(JSON.stringify(call.tools)) : 0;
  return estimateTokens(call.messages, { model: call.model }) + tools + (call.maxTokens ?? 0);
}

/** `call`, with each `withRetry()` retry inside it booked against `requestsPerMinute`: every HTTP request counts. */
function countingRetries(call: GenerateOptions, limiter: RateLimiter): GenerateOptions {
  return withProviderEvents(call, { retry: () => limiter['bookStart'](), fallback: () => undefined });
}

/**
 * Queue a provider's `generate()` and `stream()` calls to stay under the
 * limits. Calls are admitted in order; one waiting for its turn
 * rejects with the call's `signal` reason when aborted. A `stream()` holds its
 * `maxConcurrent` slot until the stream is read to its end (or its final
 * values settle). Pass a {@link RateLimiter} (`createRateLimiter()`) to share
 * one budget between several providers.
 *
 * Outside `withRetry()` (as `createAgent({ rateLimit, retry })` puts it), a
 * call holds one slot through its retries, and each retry still counts as a
 * request against `requestsPerMinute`; inside, every attempt queues on its own.
 *
 * @example
 * ```ts
 * const provider = withRateLimit(resolveProvider('openai/gpt-4o-mini'), {
 *   requestsPerMinute: 60,
 *   tokensPerMinute: 200_000,
 *   maxConcurrent: 4,
 * });
 * ```
 */
export function withRateLimit(provider: LLMProvider, limits: RateLimitOptions | RateLimiter): LLMProvider {
  const limiter = limits instanceof RateLimiter ? limits : new RateLimiter(limits);
  return {
    get name() {
      return provider.name;
    },
    get defaultModel() {
      return provider.defaultModel;
    },
    async generate(call) {
      const lease = await limiter.acquire(estimateCall(call), call.signal);
      try {
        const result = await provider.generate(countingRetries(call, limiter));
        lease.release(result.usage?.totalTokens);
        return result;
      } catch (error) {
        lease.release();
        throw error;
      }
    },
    async stream(call) {
      const lease = await limiter.acquire(estimateCall(call), call.signal);
      let streamed: StreamResult;
      try {
        streamed = await provider.stream(countingRetries(call, limiter));
      } catch (error) {
        lease.release();
        throw error;
      }
      // The slot is freed when the stream ends, or - when nobody reads the stream - its text settles.
      // The final values are read when needed, not now: a `withRetry()` inside swaps them for each retry's.
      let reading = false;
      Promise.resolve(streamed.text).then(
        () => reading || lease.release(),
        () => reading || lease.release()
      );
      const source = streamed.fullStream;
      const fullStream = (async function* (): AsyncGenerator<StreamChunk> {
        reading = true;
        try {
          yield* source;
          // The reported usage re-books the call.
          lease.adjust((await Promise.resolve(streamed.usage).catch(() => undefined))?.totalTokens);
        } finally {
          lease.release();
        }
      })();
      return {
        fullStream,
        get textStream() {
          return streamed.textStream;
        },
        get text() {
          return streamed.text;
        },
        get usage() {
          return streamed.usage;
        },
        get finishReason() {
          return streamed.finishReason;
        },
        get toolCalls() {
          return streamed.toolCalls;
        },
        get servedBy() {
          return streamed.servedBy;
        },
        set servedBy(value) {
          streamed.servedBy = value;
        },
      };
    },
    ...delegateCapabilities(provider),
  };
}
