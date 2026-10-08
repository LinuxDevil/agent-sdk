/**
 * Internal (LOU-V7.2): how a streaming run hears about the retries and
 * fallbacks of the model calls it makes. The run attaches a listener to each
 * request (`withProviderEvents()`); `withRetry()` and `withFallback()` report
 * to the listener of the call they handle, besides their own `onRetry` /
 * `onFallback`. Keyed by a symbol, so it never reaches a provider's wire
 * format, and not re-exported from the providers barrel.
 */

import type { GenerateOptions } from './llm';

/** A retry of one call: `RetryInfo` plus the wrapper's limit and the provider's name. */
export interface ProviderRetryReport {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: unknown;
  provider: string;
}

/** The next provider of a `withFallback()` takes over the call. */
export interface ProviderFallbackReport {
  from: string;
  to: string;
  error: unknown;
}

export interface ProviderEventListener {
  retry(report: ProviderRetryReport): void;
  fallback(report: ProviderFallbackReport): void;
}

const PROVIDER_EVENTS: unique symbol = Symbol('lousho.providerEvents');

const RETRIES_OWNED: unique symbol = Symbol('lousho.retriesOwned');

type ListenedCall = GenerateOptions & { [PROVIDER_EVENTS]?: ProviderEventListener; [RETRIES_OWNED]?: true };

/**
 * `call` with `listener` attached; the wrappers keep it when they copy the
 * call. A listener already attached still hears every report, after `listener`.
 */
export function withProviderEvents(call: GenerateOptions, listener: ProviderEventListener): GenerateOptions {
  const previous = providerEventsOf(call);
  const chained: ProviderEventListener = previous
    ? {
        retry: (report) => (listener.retry(report), previous.retry(report)),
        fallback: (report) => (listener.fallback(report), previous.fallback(report)),
      }
    : listener;
  const listened: ListenedCall = { ...call, [PROVIDER_EVENTS]: chained };
  return listened;
}

/**
 * C2: `call` marked as retried by `withRetry()`, so an 'ai'-SDK-backed
 * provider sends it with the 'ai' SDK's own retries off (`maxRetries: 0`):
 * one retry layer, never one multiplied by the other.
 */
export function withRetriesOwned(call: GenerateOptions): GenerateOptions {
  const owned: ListenedCall = { ...call, [RETRIES_OWNED]: true };
  return owned;
}

/** Whether `withRetry()` retries `call` (see `withRetriesOwned()`). */
export function retriesOwned(call: GenerateOptions): boolean {
  return (call as ListenedCall)[RETRIES_OWNED] === true;
}

/** The listener attached to `call`, if any. */
export function providerEventsOf(call: GenerateOptions): ProviderEventListener | undefined {
  return (call as ListenedCall)[PROVIDER_EVENTS];
}
