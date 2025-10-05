/**
 * Error Classes Tests
 */

import { describe, it, expect } from 'vitest';
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
} from './errors';

describe('Error Classes', () => {
  describe('SDKError', () => {
    it('should create SDK error', () => {
      const error = new SDKError('Test error', 'TEST_CODE');
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_CODE');
      expect(error.name).toBe('SDKError');
    });
  });

  describe('AgentExecutionError', () => {
    it('should create agent execution error', () => {
      const cause = new Error('Original error');
      const error = new AgentExecutionError('Agent failed', 'agent-1', cause);

      expect(error.message).toBe('Agent failed');
      expect(error.agentId).toBe('agent-1');
      expect(error.cause).toBe(cause);
      expect(error.code).toBe('AGENT_EXECUTION_ERROR');
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

      expect(error.message).toBe('Flow failed');
      expect(error.flowCode).toBe('my-flow');
      expect(error.step).toBe('step-1');
      expect(error.cause).toBe(cause);
    });
  });

  describe('ConfigurationError', () => {
    it('should create configuration error', () => {
      const error = new ConfigurationError('Invalid config', 'apiKey');

      expect(error.message).toBe('Invalid config');
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

      expect(error.message).toBe('Validation failed');
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
});
