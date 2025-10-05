/**
 * Retry Logic Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  retry,
  retryOnError,
  retryWithTimeout,
  retryBatch,
  RetryableOperation,
} from './retry';
import {
  LLMProviderError,
  TimeoutError,
  RateLimitError,
  ConfigurationError,
} from './errors';

describe('Retry Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('retry', () => {
    it('should succeed on first attempt', async () => {
      const operation = vi.fn().mockResolvedValue('success');

      const result = await retry(operation);

      expect(result.value).toBe('success');
      expect(result.attempts).toBe(1);
      expect(result.totalDelayMs).toBe(0);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry on retryable error', async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new TimeoutError('Timeout'))
        .mockResolvedValueOnce('success');

      const result = await retry(operation, {
        maxAttempts: 3,
        initialDelayMs: 10,
      });

      expect(result.value).toBe('success');
      expect(result.attempts).toBe(2);
      expect(result.totalDelayMs).toBeGreaterThan(0);
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should not retry on non-retryable error', async () => {
      const operation = vi
        .fn()
        .mockRejectedValue(new ConfigurationError('Invalid config'));

      await expect(
        retry(operation, { maxAttempts: 3, initialDelayMs: 10 })
      ).rejects.toThrow('Invalid config');

      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should respect max attempts', async () => {
      const operation = vi
        .fn()
        .mockRejectedValue(new TimeoutError('Timeout'));

      await expect(
        retry(operation, { maxAttempts: 3, initialDelayMs: 10 })
      ).rejects.toThrow('Timeout');

      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('should use exponential backoff', async () => {
      let delays: number[] = [];
      const operation = vi
        .fn()
        .mockRejectedValue(new TimeoutError('Timeout'));

      await expect(
        retry(operation, {
          maxAttempts: 3,
          initialDelayMs: 100,
          backoffMultiplier: 2,
          onRetry: (_error, _attempt, delay) => {
            delays.push(delay);
          },
        })
      ).rejects.toThrow('Timeout');

      expect(delays.length).toBe(2); // 2 retries for 3 attempts
      expect(delays[1]).toBeGreaterThan(delays[0]); // Second delay > first delay
    });

    it('should respect max delay', async () => {
      let delays: number[] = [];
      const operation = vi
        .fn()
        .mockRejectedValue(new TimeoutError('Timeout'));

      await expect(
        retry(operation, {
          maxAttempts: 5,
          initialDelayMs: 100,
          maxDelayMs: 200,
          backoffMultiplier: 3,
          onRetry: (_error, _attempt, delay) => {
            delays.push(delay);
          },
        })
      ).rejects.toThrow('Timeout');

      expect(delays.every((d) => d <= 200)).toBe(true);
    }, 10000); // Increase timeout to 10 seconds

    it('should call onRetry callback', async () => {
      const onRetry = vi.fn();
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new TimeoutError('Timeout'))
        .mockResolvedValueOnce('success');

      await retry(operation, {
        maxAttempts: 3,
        initialDelayMs: 10,
        onRetry,
      });

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(
        expect.any(TimeoutError),
        1,
        expect.any(Number)
      );
    });

    it('should use custom shouldRetry function', async () => {
      const shouldRetry = vi.fn().mockReturnValue(false);
      const operation = vi
        .fn()
        .mockRejectedValue(new TimeoutError('Timeout'));

      await expect(
        retry(operation, {
          maxAttempts: 3,
          initialDelayMs: 10,
          shouldRetry,
        })
      ).rejects.toThrow('Timeout');

      expect(operation).toHaveBeenCalledTimes(1);
      expect(shouldRetry).toHaveBeenCalledTimes(1);
    });

    it('should use retry delay from error', async () => {
      let actualDelay = 0;
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new RateLimitError('Rate limit', 1))
        .mockResolvedValueOnce('success');

      await retry(operation, {
        maxAttempts: 3,
        onRetry: (_error, _attempt, delay) => {
          actualDelay = delay;
        },
      });

      expect(actualDelay).toBe(1000); // 1 second
    });
  });

  describe('retryOnError', () => {
    it('should retry only on specified error types', async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new TimeoutError('Timeout'))
        .mockResolvedValueOnce('success');

      const result = await retryOnError(
        operation,
        [TimeoutError],
        { maxAttempts: 3, initialDelayMs: 10 }
      );

      expect(result.value).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should not retry on different error types', async () => {
      const operation = vi
        .fn()
        .mockRejectedValue(new ConfigurationError('Invalid'));

      await expect(
        retryOnError(operation, [TimeoutError], {
          maxAttempts: 3,
          initialDelayMs: 10,
        })
      ).rejects.toThrow('Invalid');

      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry on multiple error types', async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new TimeoutError('Timeout'))
        .mockRejectedValueOnce(
          new LLMProviderError('Server error', 'openai', 500)
        )
        .mockResolvedValueOnce('success');

      const result = await retryOnError(
        operation,
        [TimeoutError, LLMProviderError],
        { maxAttempts: 4, initialDelayMs: 10 }
      );

      expect(result.value).toBe('success');
      expect(operation).toHaveBeenCalledTimes(3);
    });
  });

  describe('retryWithTimeout', () => {
    it('should timeout operation if takes too long', async () => {
      const operation = () =>
        new Promise((resolve) => setTimeout(() => resolve('success'), 1000));

      await expect(
        retryWithTimeout(operation, 100, { maxAttempts: 1 })
      ).rejects.toThrow('Operation timed out');
    });

    it('should succeed if operation completes within timeout', async () => {
      const operation = () =>
        new Promise((resolve) => setTimeout(() => resolve('success'), 50));

      const result = await retryWithTimeout(operation, 200, {
        maxAttempts: 1,
      });

      expect(result.value).toBe('success');
    });
  });

  describe('retryBatch', () => {
    it('should retry multiple operations', async () => {
      const op1 = vi.fn().mockResolvedValue('result1');
      const op2 = vi
        .fn()
        .mockRejectedValueOnce(new TimeoutError('Timeout'))
        .mockResolvedValueOnce('result2');
      const op3 = vi.fn().mockResolvedValue('result3');

      const results = await retryBatch([op1, op2, op3], {
        maxAttempts: 3,
        initialDelayMs: 10,
      });

      expect(results[0].value).toBe('result1');
      expect(results[1].value).toBe('result2');
      expect(results[2].value).toBe('result3');
      expect(results[1].attempts).toBe(2);
    });

    it('should fail batch if any operation fails', async () => {
      const op1 = vi.fn().mockResolvedValue('result1');
      const op2 = vi.fn().mockRejectedValue(new Error('Failed'));
      const op3 = vi.fn().mockResolvedValue('result3');

      await expect(
        retryBatch([op1, op2, op3], {
          maxAttempts: 2,
          initialDelayMs: 10,
          shouldRetry: () => false,
        })
      ).rejects.toThrow('Failed');
    });
  });

  describe('RetryableOperation', () => {
    it('should execute operation successfully', async () => {
      const operation = vi.fn().mockResolvedValue('success');
      const retryable = new RetryableOperation(operation, {
        maxAttempts: 3,
        initialDelayMs: 10,
      });

      const result = await retryable.execute();

      expect(result.value).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should open circuit breaker after threshold', async () => {
      const operation = vi.fn().mockRejectedValue(new Error('Failed'));
      const retryable = new RetryableOperation(operation, {
        maxAttempts: 1,
        initialDelayMs: 10,
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 1000,
        shouldRetry: () => false,
      });

      // Fail 3 times to open circuit
      await expect(retryable.execute()).rejects.toThrow('Failed');
      await expect(retryable.execute()).rejects.toThrow('Failed');
      await expect(retryable.execute()).rejects.toThrow('Failed');

      // Circuit should be open now
      await expect(retryable.execute()).rejects.toThrow('Circuit breaker is open');
    });

    it('should reset circuit breaker after timeout', async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new Error('Failed'))
        .mockResolvedValueOnce('success');

      const retryable = new RetryableOperation(operation, {
        maxAttempts: 1,
        initialDelayMs: 10,
        circuitBreakerThreshold: 1,
        circuitBreakerResetMs: 100,
        shouldRetry: () => false,
      });

      // Open circuit
      await expect(retryable.execute()).rejects.toThrow('Failed');

      // Wait for reset
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should work now
      const result = await retryable.execute();
      expect(result.value).toBe('success');
    });

    it('should reset circuit breaker on success', async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new TimeoutError('Timeout'))
        .mockResolvedValueOnce('success');

      const retryable = new RetryableOperation(operation, {
        maxAttempts: 2,
        initialDelayMs: 10,
      });

      await retryable.execute();

      const status = retryable.getStatus();
      expect(status.failureCount).toBe(0);
      expect(status.isOpen).toBe(false);
    });

    it('should manually reset circuit breaker', async () => {
      const operation = vi.fn().mockRejectedValue(new Error('Failed'));
      const retryable = new RetryableOperation(operation, {
        maxAttempts: 1,
        initialDelayMs: 10,
        circuitBreakerThreshold: 1,
        shouldRetry: () => false,
      });

      await expect(retryable.execute()).rejects.toThrow('Failed');

      retryable.reset();

      const status = retryable.getStatus();
      expect(status.failureCount).toBe(0);
      expect(status.isOpen).toBe(false);
    });

    it('should get circuit breaker status', async () => {
      const operation = vi.fn().mockRejectedValue(new Error('Failed'));
      const retryable = new RetryableOperation(operation, {
        maxAttempts: 1,
        shouldRetry: () => false,
      });

      let status = retryable.getStatus();
      expect(status.isOpen).toBe(false);
      expect(status.failureCount).toBe(0);

      await expect(retryable.execute()).rejects.toThrow('Failed');

      status = retryable.getStatus();
      expect(status.failureCount).toBe(1);
      expect(status.lastFailureTime).not.toBeNull();
    });
  });
});
