/**
 * Retry Logic
 * Exponential backoff and retry utilities
 */

import { isRetryableError, getRetryDelay, TimeoutError } from './errors';

/**
 * Retry options
 */
export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  timeout?: number;
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;
  shouldRetry?: (error: Error, attempt: number) => boolean;
  /**
   * Stops retrying once aborted (LOU-V1): the error of the attempt that
   * was running is rethrown instead of scheduling another attempt.
   * Independently of this option, an error named `AbortError` is never
   * retried - a cancelled operation is not a transient failure.
   *
   * @example
   * ```ts
   * await retry(() => provider.generate({ messages, signal }), { signal });
   * ```
   */
  signal?: AbortSignal;
}

/** Whether an attempt's failure is a cancellation, which is never retried. */
function isAbort(error: Error, signal: AbortSignal | undefined): boolean {
  return error?.name === 'AbortError' || signal?.aborted === true;
}

/**
 * Retry result
 */
export interface RetryResult<T> {
  value: T;
  attempts: number;
  totalDelayMs: number;
}

/**
 * Retry an async operation with exponential backoff
 * 
 * @example
 * ```typescript
 * const result = await retry(
 *   async () => {
 *     return await provider.generate({ messages });
 *   },
 *   {
 *     maxAttempts: 3,
 *     initialDelayMs: 1000,
 *     onRetry: (error, attempt, delay) => {
 *       logger.info('Retry attempt', { attempt, delay, error: error.message });
 *     },
 *   }
 * );
 * ```
 */
export async function retry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 60000,
    backoffMultiplier = 2,
    timeout,
    onRetry,
    shouldRetry = isRetryableError,
    signal,
  } = options;

  let attempt = 0;
  let totalDelayMs = 0;
  let lastError: Error | undefined;

  while (attempt < maxAttempts) {
    attempt++;

    try {
      const value = await runAttempt(operation, timeout);

      return {
        value,
        attempts: attempt,
        totalDelayMs,
      };
    } catch (error) {
      lastError = error as Error;

      // Don't retry if it's the last attempt, the operation was cancelled,
      // or the error isn't retryable
      if (
        attempt >= maxAttempts ||
        isAbort(lastError, signal) ||
        !shouldRetry(lastError, attempt)
      ) {
        break;
      }

      const delayMs = computeRetryDelay(lastError, attempt, {
        initialDelayMs,
        maxDelayMs,
        backoffMultiplier,
      });

      totalDelayMs += delayMs;

      // Call onRetry callback
      if (onRetry) {
        onRetry(lastError, attempt, delayMs);
      }

      // Wait before retrying
      await sleep(delayMs);
    }
  }

  // All attempts failed
  throw lastError;
}

/**
 * Run one attempt of the operation, applying the per-attempt timeout if specified
 */
async function runAttempt<T>(operation: () => Promise<T>, timeout: number | undefined): Promise<T> {
  return timeout ? await withTimeout(operation(), timeout) : await operation();
}

/**
 * Delay before the next attempt: the error's own retry-after hint if it has
 * one, otherwise exponential backoff with jitter
 */
function computeRetryDelay(
  error: Error,
  attempt: number,
  backoff: { initialDelayMs: number; maxDelayMs: number; backoffMultiplier: number }
): number {
  const retryAfterMs = getRetryDelay(error);
  if (retryAfterMs !== undefined) {
    return retryAfterMs;
  }

  const { initialDelayMs, maxDelayMs, backoffMultiplier } = backoff;

  // Use exponential backoff
  let delayMs = Math.min(
    initialDelayMs * Math.pow(backoffMultiplier, attempt - 1),
    maxDelayMs
  );

  // Add jitter (±20%)
  const jitter = delayMs * 0.2 * (Math.random() - 0.5);
  delayMs = Math.round(delayMs + jitter);

  // Ensure delay doesn't exceed maxDelayMs after jitter
  return Math.min(delayMs, maxDelayMs);
}

/**
 * Retry with specific error types
 */
export async function retryOnError<T>(
  operation: () => Promise<T>,
  errorTypes: (new (...args: any[]) => Error)[],
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  return retry(operation, {
    ...options,
    shouldRetry: (error, attempt) => {
      // Check if error matches any of the specified types
      const isMatchingError = errorTypes.some(
        (ErrorType) => error instanceof ErrorType
      );

      if (!isMatchingError) {
        return false;
      }

      // Also check the default retry logic
      if (options.shouldRetry) {
        return options.shouldRetry(error, attempt);
      }

      return isRetryableError(error);
    },
  });
}

/**
 * Retry with timeout for each attempt
 */
export async function retryWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  return retry(operation, {
    ...options,
    timeout: timeoutMs,
  });
}

/**
 * Batch retry multiple operations
 */
export async function retryBatch<T>(
  operations: Array<() => Promise<T>>,
  options: RetryOptions = {}
): Promise<Array<RetryResult<T>>> {
  return Promise.all(operations.map((op) => retry(op, options)));
}

/**
 * Retry with exponential backoff and circuit breaker
 */
export class RetryableOperation<T> {
  private failureCount = 0;
  private lastFailureTime: number | null = null;
  private circuitBreakerThreshold: number;
  private circuitBreakerResetMs: number;

  constructor(
    private operation: () => Promise<T>,
    private options: RetryOptions & {
      circuitBreakerThreshold?: number;
      circuitBreakerResetMs?: number;
    } = {}
  ) {
    this.circuitBreakerThreshold =
      options.circuitBreakerThreshold ?? 5;
    this.circuitBreakerResetMs =
      options.circuitBreakerResetMs ?? 60000;
  }

  async execute(): Promise<RetryResult<T>> {
    // Check circuit breaker
    if (this.isCircuitOpen()) {
      throw new Error(
        `Circuit breaker is open. Too many failures (${this.failureCount}). Try again later.`
      );
    }

    try {
      const result = await retry(this.operation, this.options);
      
      // Reset failure count on success
      this.failureCount = 0;
      this.lastFailureTime = null;

      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  private isCircuitOpen(): boolean {
    if (this.failureCount < this.circuitBreakerThreshold) {
      return false;
    }

    if (!this.lastFailureTime) {
      return false;
    }

    // Check if enough time has passed to try again
    const timeSinceLastFailure = Date.now() - this.lastFailureTime;
    if (timeSinceLastFailure >= this.circuitBreakerResetMs) {
      // Reset the circuit
      this.failureCount = 0;
      this.lastFailureTime = null;
      return false;
    }

    return true;
  }

  private recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
  }

  reset(): void {
    this.failureCount = 0;
    this.lastFailureTime = null;
  }

  getStatus(): {
    isOpen: boolean;
    failureCount: number;
    lastFailureTime: number | null;
  } {
    return {
      isOpen: this.isCircuitOpen(),
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap operation with timeout
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new TimeoutError(
          `Operation timed out after ${timeoutMs}ms`,
          timeoutMs
        )
      );
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}
