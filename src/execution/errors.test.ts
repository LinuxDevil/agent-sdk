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

    it('maps a llama.cpp/LM Studio context overflow (HTTP 500) to context-length-exceeded, not retryable', () => {
      // The exact bodies llama.cpp / LM Studio answer with (audit _cross X1,
      // log-incident F2): the overflow is wrapped in a 500, which used to
      // fall through to `err.isRetryable` (true for a 5xx) - so withRetry()
      // retried a request that can never succeed.
      const raw = new APICallError({
        message: 'request (20018 tokens) exceeds the available context size (8192 tokens)',
        url: 'http://localhost:1234/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 500,
        responseBody: JSON.stringify({
          error: {
            message: 'request (20018 tokens) exceeds the available context size (8192 tokens)',
            type: 'exceed_context_size_error',
          },
        }),
        isRetryable: true,
      });

      const compacted = compactProviderError(raw, 'lmstudio');
      expect(compacted.category).toBe('context-length-exceeded');
      expect(compacted.retryable).toBe(false);
    });

    it("recognizes the 'exceed_context_size_error' type even with a generic message", () => {
      const raw = new APICallError({
        message: 'Internal Server Error',
        url: 'http://localhost:1234/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 500,
        responseBody: '{"type":"exceed_context_size_error"}',
        isRetryable: true,
      });

      expect(compactProviderError(raw, 'llamacpp')).toMatchObject({
        category: 'context-length-exceeded',
        retryable: false,
      });
    });

    it('classifies a streamed context-overflow error event the same way as a generate() one', () => {
      // LM Studio's streamed variant arrives as an SSE error event, surfaced
      // as a plain Error, not an APICallError (log-incident F2).
      const streamed = compactProviderError(new Error('Context size has been exceeded.'), 'lmstudio');
      expect(streamed.category).toBe('context-length-exceeded');
      expect(streamed.retryable).toBe(false);
    });

    it("folds the upstream provider's message (OpenRouter error.metadata.raw) into the compacted error", () => {
      // What OpenRouter returns when the upstream provider rejects the call:
      // the generic "Provider returned error", the upstream body verbatim in
      // error.metadata.raw (audit repo-maintainer F2).
      const upstream =
        "Invalid schema for response_format 'r': 'required' is required to be supplied " +
        "and to be an array including every key in properties. Missing 's'.";
      const raw = new APICallError({
        message: 'Provider returned error',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 400,
        responseBody: JSON.stringify({
          error: {
            message: 'Provider returned error',
            code: 400,
            metadata: {
              raw: JSON.stringify({ error: { message: upstream, type: 'invalid_request_error' } }),
              provider_name: 'OpenAI',
            },
          },
        }),
        isRetryable: false,
      });

      const compacted = compactProviderError(raw, 'openrouter');
      expect(compacted.error).toContain('Provider returned error');
      expect(compacted.error).toContain("Invalid schema for response_format 'r'");
      expect(compacted.category).toBe('unknown');
    });

    it('bounds the upstream message folded into the compacted error', () => {
      const raw = new APICallError({
        message: 'Provider returned error',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 500,
        responseBody: JSON.stringify({
          error: { message: 'Provider returned error', metadata: { raw: JSON.stringify({ error: { message: 'y'.repeat(5000) } }) } },
        }),
        isRetryable: true,
      });

      const compacted = compactProviderError(raw, 'openrouter');
      expect(compacted.error.length).toBeLessThan(600);
      // the bounded responseBody snippet still carries the upstream metadata.raw reason
      expect(compacted.error.endsWith('...')).toBe(true);
      expect(compacted.error).toContain('metadata');
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

  describe('C1: local-runtime errors (llama.cpp / LM Studio)', () => {
    // Bodies verbatim from audit/_cross X1, audit/invoice-extract repro/error-body.ts
    // and audit/coding-agent repro/classify-lmstudio-error.out.txt.
    const LLAMA_CPP_BODY = JSON.stringify({
      error: {
        code: 500,
        message: 'request (20018 tokens) exceeds the available context size (8192 tokens), try increasing it',
        type: 'exceed_context_size_error',
        n_prompt_tokens: 20018,
        n_ctx: 8192,
      },
    });
    const BODY_CHAT = JSON.stringify({ error: 'Engine protocol predict stream returned an error: {"code":500,"message":"Context size has been exceeded.","type":"server_error"}' });
    const BODY_RESP = JSON.stringify({ error: { message: 'Engine protocol predict stream returned an error: Context size has been exceeded.', type: 'internal_error', param: null, code: 'unknown' } });

    const apiError = (statusCode: number, message: string, responseBody: string, extra: Partial<ConstructorParameters<typeof APICallError>[0]> = {}) =>
      new APICallError({
        message,
        url: 'http://localhost:1234/v1/responses',
        requestBodyValues: {},
        statusCode,
        responseBody,
        isRetryable: statusCode >= 500,
        ...extra,
      });

    it('maps the llama.cpp exceed_context_size_error 500 to context-length-exceeded/non-retryable', () => {
      const compacted = compactProviderError(apiError(500, 'request (20018 tokens) exceeds the available context size (8192 tokens), try increasing it', LLAMA_CPP_BODY));
      expect(compacted).toMatchObject({ category: 'context-length-exceeded', retryable: false, statusCode: 500 });
    });

    it('matches on the body alone (type / n_ctx) when the message is generic', () => {
      const compacted = compactProviderError(apiError(500, 'Internal Server Error', LLAMA_CPP_BODY));
      expect(compacted).toMatchObject({ category: 'context-length-exceeded', retryable: false });
    });

    it('unwraps a RetryError around the llama.cpp 500 to the same classification', () => {
      const last = apiError(500, 'request (20018 tokens) exceeds the available context size (8192 tokens), try increasing it', LLAMA_CPP_BODY);
      const raw = new RetryError({ message: 'Failed after 3 attempts', reason: 'maxRetriesExceeded', errors: [last, last, last] });
      expect(compactProviderError(raw)).toMatchObject({ category: 'context-length-exceeded', retryable: false });
    });

    it('maps LM Studio "Context size has been exceeded" the same on chat (400), responses (500) and the stream', () => {
      const chat = compactProviderError(apiError(400, 'Bad Request', BODY_CHAT));
      const responses = compactProviderError(
        apiError(500, 'Engine protocol predict stream returned an error: Context size has been exceeded.', BODY_RESP)
      );
      const streamError = compactProviderError(
        new Error('Engine protocol predict stream returned an error: {"code":500,"message":"Context size has been exceeded.","type":"server_error"}')
      );
      const streamObject = compactProviderError({ type: 'error', error: { code: 500, message: 'Context size has been exceeded.' } });
      for (const compacted of [chat, responses, streamError, streamObject]) {
        expect(compacted).toMatchObject({ category: 'context-length-exceeded', retryable: false });
      }
    });

    it('never turns an object-valued stream error into "[object Object]"', () => {
      expect(compactProviderError({ code: 500, message: 'Context size has been exceeded.' }).error).toBe('Context size has been exceeded.');
      expect(compactProviderError({ type: 'error', error: { code: 500, message: 'boom' } }).error).toBe('boom');
      expect(compactProviderError({ code: 'weird', detail: 'x' }).error).toBe('{"code":"weird","detail":"x"}');
    });

    it('appends a snippet of an unparsed body to a bare status-text message', () => {
      const compacted = compactProviderError(apiError(400, 'Bad Request', BODY_CHAT, { requestBodyValues: { secret: 'do-not-leak' } }));
      expect(compacted.error).toMatch(/^Bad Request: \{"error":"Engine protocol predict stream returned an error/);
      expect(compacted.error).not.toContain('do-not-leak');
      const long = compactProviderError(apiError(400, 'Bad Request', `{"error":"${'y'.repeat(5000)}"}`));
      expect(long.error.length).toBeLessThan(600);
    });

    it('leaves a parsed message alone (no body snippet)', () => {
      const compacted = compactProviderError(
        apiError(500, 'Engine protocol predict stream returned an error: Context size has been exceeded.', BODY_RESP)
      );
      expect(compacted.error).toBe('Engine protocol predict stream returned an error: Context size has been exceeded.');
    });

    it('names ECONNREFUSED and the URL for a refused connection (cause chain) as timeout/retryable', () => {
      const refused = Object.assign(new AggregateError([new Error('connect ECONNREFUSED 127.0.0.1:1234')], ''), { code: 'ECONNREFUSED' });
      const raw = new APICallError({
        message: 'Cannot connect to API: ',
        url: 'http://localhost:1234/v1/responses?key=secret',
        requestBodyValues: {},
        cause: refused,
        isRetryable: true,
      });
      const compacted = compactProviderError(raw, 'openai');
      expect(compacted).toMatchObject({ category: 'timeout', retryable: true });
      expect(compacted.error).toBe('Cannot connect to API: connection refused (ECONNREFUSED) at http://localhost:1234/v1/responses - is the server running?');
      expect(compacted.error).not.toContain('secret');
    });

    it('names ENOTFOUND for a plain fetch failure whose cause carries the code', () => {
      const raw = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND nohost'), { code: 'ENOTFOUND' }) });
      const compacted = compactProviderError(raw);
      expect(compacted).toMatchObject({ category: 'timeout', retryable: true });
      expect(compacted.error).toContain('ENOTFOUND');
    });

    it('maps an undici Headers Timeout Error to timeout/retryable', () => {
      const cause = Object.assign(new Error('Headers Timeout Error'), { name: 'HeadersTimeoutError', code: 'UND_ERR_HEADERS_TIMEOUT' });
      const raw = new APICallError({
        message: 'Cannot connect to API: Headers Timeout Error',
        url: 'http://localhost:1234/v1/chat/completions',
        requestBodyValues: {},
        cause,
        isRetryable: true,
      });
      const compacted = compactProviderError(raw);
      expect(compacted).toMatchObject({ category: 'timeout', retryable: true });
      expect(compacted.error).toContain('UND_ERR_HEADERS_TIMEOUT');
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
