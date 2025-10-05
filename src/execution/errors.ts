/**
 * Error Classes
 * Custom error types for SDK operations
 */

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
