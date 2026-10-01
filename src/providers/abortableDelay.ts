/**
 * Waits `ms`, rejecting with the signal's reason as soon as it is aborted
 * (LOU-V1), or at once when it already is. Shared by the mock provider's
 * simulated latency and `withRetry()`'s backoff (LOU-V7.1).
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted(); // rejects this promise
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
