/**
 * Error Classes Tests
 */

import { describe, it, expect } from 'vitest';
import { APICallError, LoadAPIKeyError, RetryError } from 'ai';
import {
  SDKError,
  AgentExecutionError,
  ToolExecutionError,
  LLMProviderError,
  FlowExecutionError,
  ConfigurationError,
  ValidationError,
  TimeoutError,
  RateLimitError,
  isRetryableError,
  isNetworkError,
  getRetryDelay,
  compactProviderError,
  isModelActionableProviderErrorCategory,
  isCassetteError,
  CompactedLLMProviderError,
} from './errors';

describe('Error Classes', () => {
  describe('SDKError', () => {
    it('should create SDK error', () => {
      const error = new SDKError('Test error', 'TEST_CODE');
      expect(error.message).toBe('Test error\n[TEST_CODE]');
      expect(error.detail).toBe('Test error');
      expect(error.code).toBe('TEST_CODE');
      expect(error.name).toBe('SDKError');
    });

    it('appends [code] hint (docs) from the registry to message and toString() (LOU-D2)', () => {
      const error = new SDKError('Boom', 'LOUSHO_CONFIG_INVALID');
      const help =
        '[LOUSHO_CONFIG_INVALID] Fix the option named in the message. ' +
        '(https://github.com/LinuxDevil/agent-sdk/blob/main/docs/errors.md#lousho_config_invalid)';
      expect(error.hint).toBe('Fix the option named in the message.');
      expect(error.docs).toBe('https://github.com/LinuxDevil/agent-sdk/blob/main/docs/errors.md#lousho_config_invalid');
      expect(error.message).toBe(`Boom\n${help}`);
      expect(error.toString()).toBe(`SDKError: Boom\n${help}`);
      expect(new SDKError('x').code).toBe('LOUSHO_GENERIC_ERROR');
    });

    it('keeps a model-facing message as given but still formats toString() (LOU-D2)', () => {
      const error = new ToolExecutionError('Tool error', 'http');
      expect(error.message).toBe('Tool error');
      expect(error.code).toBe('LOUSHO_TOOL_EXECUTION_FAILED');
      expect(error.toString()).toMatch(/^ToolExecutionError: Tool error\n\[LOUSHO_TOOL_EXECUTION_FAILED\] .+ \(https:\/\/.+#lousho_tool_execution_failed\)$/);
      expect(new LLMProviderError('x').code).toBe('LOUSHO_PROVIDER_REQUEST_FAILED');
      expect(new TimeoutError('x').code).toBe('LOUSHO_OPERATION_TIMEOUT');
      expect(new RateLimitError('x').code).toBe('LOUSHO_PROVIDER_RATE_LIMITED');
    });
  });

  describe('AgentExecutionError', () => {
    it('should create agent execution error', () => {
      const cause = new Error('Original error');
      const error = new AgentExecutionError('Agent failed', 'agent-1', cause);

      expect(error.detail).toBe('Agent failed');
      expect(error.agentId).toBe('agent-1');
      expect(error.cause).toBe(cause);
      expect(error.code).toBe('LOUSHO_AGENT_EXECUTION_FAILED');
    });
  });

  describe('ToolExecutionError', () => {
    it('should create tool execution error', () => {
      const cause = new Error('Tool failed');
      const error = new ToolExecutionError('Tool error', 'http', cause);

      expect(error.message).toBe('Tool error');
      expect(error.toolName).toBe('http');
      expect(error.cause).toBe(cause);
    });
  });

  describe('LLMProviderError', () => {
    it('should create LLM provider error', () => {
      const cause = new Error('API error');
      const error = new LLMProviderError(
        'Provider failed',
        'openai',
        500,
        cause
      );

      expect(error.message).toBe('Provider failed');
      expect(error.providerName).toBe('openai');
      expect(error.statusCode).toBe(500);
      expect(error.cause).toBe(cause);
    });
  });

  describe('FlowExecutionError', () => {
    it('should create flow execution error', () => {
      const cause = new Error('Step failed');
      const error = new FlowExecutionError(
        'Flow failed',
        'my-flow',
        'step-1',
        cause
      );

      expect(error.detail).toBe('Flow failed');
      expect(error.code).toBe('LOUSHO_FLOW_EXECUTION_FAILED');
      expect(error.flowCode).toBe('my-flow');
      expect(error.step).toBe('step-1');
      expect(error.cause).toBe(cause);
    });
  });

  describe('ConfigurationError', () => {
    it('should create configuration error', () => {
      const error = new ConfigurationError('Invalid config', 'apiKey');

      expect(error.detail).toBe('Invalid config');
      expect(error.code).toBe('LOUSHO_CONFIG_INVALID');
      expect(error.field).toBe('apiKey');
    });
  });

  describe('ValidationError', () => {
    it('should create validation error', () => {
      const errors = {
        name: ['Name is required'],
        email: ['Invalid email format'],
      };
      const error = new ValidationError('Validation failed', errors);

      expect(error.detail).toBe('Validation failed');
      expect(error.code).toBe('LOUSHO_VALIDATION_FAILED');
      expect(error.errors).toEqual(errors);
    });
  });

  describe('TimeoutError', () => {
    it('should create timeout error', () => {
      const error = new TimeoutError('Operation timed out', 5000, 'generate');

      expect(error.message).toBe('Operation timed out');
      expect(error.timeoutMs).toBe(5000);
      expect(error.operation).toBe('generate');
    });
  });

  describe('RateLimitError', () => {
    it('should create rate limit error', () => {
      const error = new RateLimitError('Rate limit exceeded', 60, 100);

      expect(error.message).toBe('Rate limit exceeded');
      expect(error.retryAfter).toBe(60);
      expect(error.limit).toBe(100);
    });
  });

  describe('isRetryableError', () => {
    it('should identify retryable errors', () => {
      expect(isRetryableError(new RateLimitError('Rate limit'))).toBe(true);
      expect(isRetryableError(new TimeoutError('Timeout'))).toBe(true);
      expect(
        isRetryableError(new LLMProviderError('Server error', 'openai', 500))
      ).toBe(true);
      expect(
        isRetryableError(new LLMProviderError('Too many requests', 'openai', 429))
      ).toBe(true);
    });

    it('should identify non-retryable errors', () => {
      expect(
        isRetryableError(new LLMProviderError('Bad request', 'openai', 400))
      ).toBe(false);
      expect(isRetryableError(new ConfigurationError('Invalid config'))).toBe(
        false
      );
      expect(isRetryableError(new Error('Generic error'))).toBe(false);
    });
  });

  describe('isNetworkError', () => {
    it('should identify network errors', () => {
      expect(isNetworkError(new Error('ECONNREFUSED'))).toBe(true);
      expect(isNetworkError(new Error('ENOTFOUND'))).toBe(true);
      expect(isNetworkError(new Error('network timeout'))).toBe(true);
      expect(isNetworkError(new Error('fetch failed'))).toBe(true);
    });

    it('should identify non-network errors', () => {
      expect(isNetworkError(new Error('Invalid argument'))).toBe(false);
      expect(isNetworkError(new Error('Validation failed'))).toBe(false);
    });
  });

  describe('getRetryDelay', () => {
    it('should extract retry delay from RateLimitError', () => {
      const error = new RateLimitError('Rate limit', 60);
      expect(getRetryDelay(error)).toBe(60000);
    });

    it('should return default delay for 429 errors', () => {
      const error = new LLMProviderError('Too many requests', 'openai', 429);
      expect(getRetryDelay(error)).toBe(60000);
    });

    it('should return undefined for other errors', () => {
      const error = new Error('Generic error');
      expect(getRetryDelay(error)).toBeUndefined();
    });
  });

  describe('LOU-T4: compactProviderError', () => {
    // Realistic per-provider error shapes, grounded in what OpenAIProvider.ts
    // / AnthropicProvider.ts / OllamaProvider.ts / OpenRouterProvider.ts
    // actually produce (all four go through the same 'ai'-SDK
    // generateText()/streamText(), so all four throw the same @ai-sdk/provider
    // error family - see src/providers/*.ts and node_modules/@ai-sdk/provider).

    it('maps a 429 APICallError (rate limit, any provider) to rate-limit/retryable', () => {
      const raw = new APICallError({
        message: 'Rate limit reached for requests',
        url: 'https://api.openai.com/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { 'retry-after': '30' },
        isRetryable: true,
      });

      const compacted = compactProviderError(raw, 'openai');

      expect(compacted.category).toBe('rate-limit');
      expect(compacted.retryable).toBe(true);
      expect(compacted.statusCode).toBe(429);
      expect(compacted.retryAfterMs).toBe(30000);
      expect(compacted.providerName).toBe('openai');
      expect(compacted.error).toBe('Rate limit reached for requests');
    });

    it('maps a 401 APICallError (bad/revoked API key) to auth-failure/non-retryable', () => {
      const raw = new APICallError({
        message: 'Incorrect API key provided',
        url: 'https://api.anthropic.com/v1/messages',
        requestBodyValues: {},
        statusCode: 401,
        isRetryable: false,
      });

      const compacted = compactProviderError(raw, 'anthropic');

      expect(compacted.category).toBe('auth-failure');
      expect(compacted.retryable).toBe(false);
    });

    it('maps a 403 APICallError to auth-failure', () => {
      const raw = new APICallError({
        message: 'Forbidden',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 403,
        isRetryable: false,
      });

      expect(compactProviderError(raw, 'openrouter').category).toBe('auth-failure');
    });

    it('maps a 408 APICallError to timeout/retryable', () => {
      const raw = new APICallError({
        message: 'Request timed out',
        url: 'https://api.openai.com/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 408,
        isRetryable: true,
      });

      const compacted = compactProviderError(raw, 'openai');
      expect(compacted.category).toBe('timeout');
      expect(compacted.retryable).toBe(true);
    });

    it('maps a 400 APICallError whose body reads as context-length-exceeded (OpenAI wording)', () => {
      const raw = new APICallError({
        message:
          "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens. Please reduce the length of the messages.",
        url: 'https://api.openai.com/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 400,
        isRetryable: false,
      });

      const compacted = compactProviderError(raw, 'openai');
      expect(compacted.category).toBe('context-length-exceeded');
      expect(compacted.retryable).toBe(false);
    });

    it('maps a 400 APICallError whose body reads as context-length-exceeded (Anthropic wording)', () => {
      const raw = new APICallError({
        message: 'prompt is too long: 210000 tokens > 200000 maximum',
        url: 'https://api.anthropic.com/v1/messages',
        requestBodyValues: {},
        statusCode: 400,
        isRetryable: false,
      });

      expect(compactProviderError(raw, 'anthropic').category).toBe('context-length-exceeded');
    });

    it('falls back to the APICallError isRetryable flag for an unrecognized 5xx', () => {
      const raw = new APICallError({
        message: 'Internal server error',
        url: 'https://api.openai.com/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 500,
        isRetryable: true,
      });

      const compacted = compactProviderError(raw, 'openai');
      expect(compacted.category).toBe('unknown');
      expect(compacted.retryable).toBe(true);
    });

    it('maps LoadAPIKeyError (no API key configured) to auth-failure/non-retryable', () => {
      const raw = new LoadAPIKeyError({ message: 'OpenAI API key is missing' });

      const compacted = compactProviderError(raw, 'openai');
      expect(compacted.category).toBe('auth-failure');
      expect(compacted.retryable).toBe(false);
    });

    it('unwraps a RetryError (ai SDK internal retries exhausted) to its lastError', () => {
      const lastError = new APICallError({
        message: 'Rate limit reached for requests',
        url: 'https://api.openai.com/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
      });
      // RetryError's constructor sets `this.lastError = errors[errors.length
      // - 1]` internally (see node_modules/ai/dist/index.js) - passing it
      // via `errors` here is exactly how the 'ai' SDK itself produces one.
      const raw = new RetryError({
        message: 'Failed after 3 attempts',
        reason: 'maxRetriesExceeded',
        errors: [lastError],
      });

      const compacted = compactProviderError(raw, 'openai');
      expect(compacted.category).toBe('rate-limit');
      expect(compacted.retryable).toBe(true);
    });

    it('maps a bare network error (e.g. Ollama daemon not running) to timeout/retryable', () => {
      const raw = new Error('connect ECONNREFUSED 127.0.0.1:11434');

      const compacted = compactProviderError(raw, 'ollama');
      expect(compacted.category).toBe('timeout');
      expect(compacted.retryable).toBe(true);
    });

    it('falls back to unknown/non-retryable for a completely generic error', () => {
      const raw = new Error('something unexpected happened');

      const compacted = compactProviderError(raw, 'mock');
      expect(compacted.category).toBe('unknown');
      expect(compacted.retryable).toBe(false);
    });

    it('handles a non-Error thrown value without crashing', () => {
      const compacted = compactProviderError('just a string', 'mock');
      expect(compacted.category).toBe('unknown');
      expect(compacted.error).toBe('just a string');
    });

    it('truncates an unusually long message so the compacted form stays small', () => {
      const raw = new Error('x'.repeat(5000));
      const compacted = compactProviderError(raw);
      expect(compacted.error.length).toBeLessThan(600);
      expect(compacted.error.endsWith('(truncated)')).toBe(true);
    });

    it('never leaks a responseBody/stack onto the compacted form', () => {
      const raw = new APICallError({
        message: 'Rate limit reached for requests',
        url: 'https://api.openai.com/v1/chat/completions',
        requestBodyValues: { secret: 'do-not-leak' },
        statusCode: 429,
        responseBody: 'x'.repeat(10000),
        isRetryable: true,
      });

      const compacted = compactProviderError(raw, 'openai');
      const serialized = JSON.stringify(compacted);
      expect(serialized).not.toContain('do-not-leak');
      expect(serialized.length).toBeLessThan(1000);
    });
  });

  describe('LOU-T4: isModelActionableProviderErrorCategory', () => {
    it('treats rate-limit, timeout and context-length-exceeded as model-actionable', () => {
      expect(isModelActionableProviderErrorCategory('rate-limit')).toBe(true);
      expect(isModelActionableProviderErrorCategory('timeout')).toBe(true);
      expect(isModelActionableProviderErrorCategory('context-length-exceeded')).toBe(true);
    });

    it('treats auth-failure and unknown as non-actionable (fail closed to the caller)', () => {
      expect(isModelActionableProviderErrorCategory('auth-failure')).toBe(false);
      expect(isModelActionableProviderErrorCategory('unknown')).toBe(false);
    });
  });

  describe('LOU-T4: CompactedLLMProviderError', () => {
    it('extends LLMProviderError so existing instanceof checks keep working', () => {
      const cause = new Error('raw provider failure');
      const error = new CompactedLLMProviderError(
        {
          error: 'Rate limit reached for requests',
          category: 'rate-limit',
          retryable: true,
          providerName: 'openai',
          statusCode: 429,
        },
        cause
      );

      expect(error).toBeInstanceOf(LLMProviderError);
      expect(error).toBeInstanceOf(SDKError);
      expect(error.message).toBe('Rate limit reached for requests');
      expect(error.providerName).toBe('openai');
      expect(error.statusCode).toBe(429);
      expect(error.cause).toBe(cause);
      expect(error.compacted.category).toBe('rate-limit');
    });
  });

  describe('LOU-R13: isCassetteError', () => {
    it('is true for a LOUSHO_CASSETTE_INVALID SDKError and anything named CassetteMismatchError', () => {
      expect(isCassetteError(new SDKError('no cassette', 'LOUSHO_CASSETTE_INVALID'))).toBe(true);
      // A CassetteMismatchError from another loaded copy of the SDK (LOU-D42) fails instanceof - the name still matches.
      expect(isCassetteError(Object.assign(new Error('mismatch'), { name: 'CassetteMismatchError' }))).toBe(true);
    });

    it('is false for other failures, which stay compactable', () => {
      expect(isCassetteError(new Error('boom'))).toBe(false);
      expect(isCassetteError(new SDKError('x', 'LOUSHO_CONFIG_INVALID'))).toBe(false);
      expect(isCassetteError(new CompactedLLMProviderError(compactProviderError(new Error('x')), new Error('x')))).toBe(false);
      expect(isCassetteError(undefined)).toBe(false);
    });
  });
});
