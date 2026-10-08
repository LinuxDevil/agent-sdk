/**
 * Provider resilience wrappers (LOU-V7.1): withRetry, withFallback,
 * resilientProvider.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';
import type { GenerateOptions, LLMProvider, StreamChunk } from './llm';
import { MockLLMProvider } from './mock';
import { isRetryableProviderError, resilientProvider, withFallback, withRetry } from './resilience';
import { CompactedLLMProviderError, compactProviderError } from '../execution/errors';
import { createAgent } from '../createAgent';
import { estimateCost } from '../models';

function apiError(statusCode: number, headers?: Record<string, string>): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://api.example.com/v1/chat',
    requestBodyValues: {},
    statusCode,
    responseHeaders: headers,
    isRetryable: statusCode >= 500 || statusCode === 429,
  });
}

/** A provider that throws `failures` in order (one per call, generate or stream), then answers `reply`. */
function flaky(failures: unknown[], name = 'flaky', reply = `${name} ok`) {
  const inner = new MockLLMProvider({ responses: [reply], defaultModel: `${name}-model` });
  const calls: GenerateOptions[] = [];
  const next = (call: GenerateOptions) => {
    calls.push(call);
    if (failures.length > 0) {
      throw failures.shift();
    }
  };
  const provider: LLMProvider = {
    name,
    defaultModel: inner.defaultModel,
    generate: async (call) => (next(call), inner.generate(call)),
    stream: async (call) => (next(call), inner.stream(call)),
    supportsTools: () => true,
    supportsStreaming: () => true,
    getModels: async () => [`${name}-model`],
  };
  return { provider, calls };
}

/**
 * A provider whose `stream()` resolves, then fails inside the stream the way
 * a streaming provider reports a request error: the fullStream's first read
 * throws, or its first chunk is an `error` chunk (LOU-R6).
 */
function flakyStream(failures: unknown[], name = 'flaky', reply = `${name} ok`) {
  const inner = new MockLLMProvider({ responses: [reply], defaultModel: `${name}-model` });
  const calls: GenerateOptions[] = [];
  const provider: LLMProvider = {
    name,
    defaultModel: inner.defaultModel,
    generate: (call) => inner.generate(call),
    stream: async (call) => {
      calls.push(call);
      const failure = failures.shift();
      if (failure === undefined) return inner.stream(call);
      if (failure === 'error-chunk') {
        return {
          fullStream: (async function* (): AsyncGenerator<StreamChunk> {
            yield { type: 'error', error: apiError(503) };
          })(),
          textStream: (async function* (): AsyncGenerator<string> {
            yield* [];
          })(),
          text: Promise.reject(apiError(503)),
          usage: Promise.resolve(undefined),
          finishReason: Promise.resolve('error'),
          toolCalls: Promise.resolve([]),
        };
      }
      return {
        fullStream: (async function* (): AsyncGenerator<StreamChunk> {
          throw failure;
        })(),
        textStream: (async function* (): AsyncGenerator<string> {
          throw failure;
        })(),
        text: Promise.reject(failure),
        usage: Promise.reject(failure),
        finishReason: Promise.reject(failure),
        toolCalls: Promise.reject(failure),
      };
    },
    supportsTools: () => true,
    supportsStreaming: () => true,
    getModels: async () => [`${name}-model`],
  };
  return { provider, calls };
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** The text of a collected stream's `text-delta` chunks. */
function textOf(chunks: StreamChunk[]): string {
  return chunks.map((chunk) => chunk.textDelta ?? '').join('');
}

const fast = { backoff: { initialMs: 1, jitter: false } };
const request: GenerateOptions = { messages: [{ role: 'user', content: 'hi' }] };

afterEach(() => {
  vi.useRealTimers();
});

describe('withRetry', () => {
  it('retries retryable failures until the provider succeeds', async () => {
    const { provider, calls } = flaky([apiError(503), apiError(429)]);
    const onRetry = vi.fn();

    const result = await withRetry(provider, { ...fast, onRetry }).generate(request);

    expect(result.text).toBe('flaky ok');
    expect(calls).toHaveLength(3);
    expect(onRetry.mock.calls.map(([info]) => [info.attempt, info.delayMs])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it('rethrows the last error once maxRetries is exhausted', async () => {
    const last = apiError(502);
    const { provider, calls } = flaky([apiError(503), last]);

    await expect(withRetry(provider, { ...fast, maxRetries: 1 }).generate(request)).rejects.toBe(last);
    expect(calls).toHaveLength(2);
  });

  it('does not retry a non-retryable error', async () => {
    const auth = apiError(401);
    const { provider, calls } = flaky([auth]);

    await expect(withRetry(provider, fast).generate(request)).rejects.toBe(auth);
    expect(calls).toHaveLength(1);
  });

  it('classifies errors like the executor does, including compacted ones', () => {
    expect(isRetryableProviderError(apiError(500))).toBe(true);
    expect(isRetryableProviderError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableProviderError(apiError(400))).toBe(false);
    expect(isRetryableProviderError(new Error('boom'))).toBe(false);
    const contextLength = new CompactedLLMProviderError(
      compactProviderError(new Error('maximum context length exceeded'))
    );
    expect(isRetryableProviderError(contextLength)).toBe(false);
  });

  it('does not retry a llama.cpp/LM Studio context overflow, whether it arrives as a 500 or a stream error', () => {
    // audit _cross X1 / log-incident F2: these runtimes wrap the overflow in
    // an HTTP 500 (which isRetryable marks retryable) or send it as an SSE
    // error event surfaced as a plain Error - both are deterministic
    // failures and must classify non-retryable.
    const wrapped = new APICallError({
      message: 'request (20018 tokens) exceeds the available context size (8192 tokens)',
      url: 'http://localhost:1234/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 500,
      isRetryable: true,
    });
    expect(isRetryableProviderError(wrapped)).toBe(false);
    expect(isRetryableProviderError(new Error('Context size has been exceeded.'))).toBe(false);
  });

  it('honors retryOn', async () => {
    const { provider, calls } = flaky([new Error('custom transient')]);
    const retryOn = vi.fn(() => true);

    await expect(withRetry(provider, { ...fast, retryOn }).generate(request)).resolves.toMatchObject({ text: 'flaky ok' });
    expect(retryOn).toHaveBeenCalledWith(expect.any(Error), 1);
    expect(calls).toHaveLength(2);
  });

  it("waits the provider's retryAfterMs instead of the backoff", async () => {
    vi.useFakeTimers();
    const { provider, calls } = flaky([apiError(429, { 'retry-after': '5' })]);
    const onRetry = vi.fn();

    const pending = withRetry(provider, { ...fast, onRetry }).generate(request);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toHaveLength(1);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, delayMs: 5_000 }));

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ text: 'flaky ok' });
    expect(calls).toHaveLength(2);
  });

  it('stops retrying when the signal aborts during the backoff wait', async () => {
    const { provider, calls } = flaky([apiError(503), apiError(503)]);
    const controller = new AbortController();
    const wrapped = withRetry(provider, {
      backoff: { initialMs: 60_000 },
      onRetry: () => controller.abort(),
    });

    await expect(wrapped.generate({ ...request, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toHaveLength(1);
  });

  it('never retries an abort and never calls the provider with an aborted signal', async () => {
    const aborted = new DOMException('stopped', 'AbortError');
    const { provider, calls } = flaky([aborted]);
    const retryOn = vi.fn(() => true);

    await expect(withRetry(provider, { ...fast, retryOn }).generate(request)).rejects.toBe(aborted);
    expect(retryOn).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort();
    await expect(withRetry(provider, { ...fast, signal: controller.signal }).generate(request)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toHaveLength(1);
  });

  it('retries a stream() call that rejects', async () => {
    const { provider, calls } = flaky([apiError(503)]);

    const stream = await withRetry(provider, fast).stream(request);

    await expect(stream.text).resolves.toBe('flaky ok');
    expect(calls).toHaveLength(2);
  });

  it('retries a stream() whose stream fails before its first chunk (LOU-R6)', async () => {
    const { provider, calls } = flakyStream([apiError(503), apiError(429)]);
    const onRetry = vi.fn();

    const stream = await withRetry(provider, { ...fast, onRetry }).stream(request);
    const chunks = await collect(stream.fullStream);

    expect(calls).toHaveLength(3);
    expect(onRetry.mock.calls.map(([info]) => info.attempt)).toEqual([1, 2]);
    expect(textOf(chunks)).toBe('flaky ok');
    await expect(stream.text).resolves.toBe('flaky ok');
  });

  it('retries a stream() whose first chunk is an error chunk (LOU-R6)', async () => {
    const { provider, calls } = flakyStream(['error-chunk']);

    const stream = await withRetry(provider, fast).stream(request);
    const chunks = await collect(stream.fullStream);

    expect(calls).toHaveLength(2);
    expect(textOf(chunks)).toBe('flaky ok');
  });

  it('rethrows the last in-stream failure once maxRetries is exhausted', async () => {
    const last = apiError(502);
    const { provider, calls } = flakyStream([apiError(503), last]);

    await expect(withRetry(provider, { ...fast, maxRetries: 1 }).stream(request)).rejects.toBe(last);
    expect(calls).toHaveLength(2);
  });

  it('does not retry a failure after the stream delivered a chunk (LOU-R6)', async () => {
    const boom = apiError(503);
    const calls: GenerateOptions[] = [];
    const inner = new MockLLMProvider({ responses: ['partial then boom'] });
    const provider: LLMProvider = {
      name: 'flaky',
      generate: (call) => inner.generate(call),
      stream: async (call) => {
        calls.push(call);
        const fullStream = (async function* (): AsyncGenerator<StreamChunk> {
          yield { type: 'text-delta', textDelta: 'partial ' };
          throw boom;
        })();
        return {
          fullStream,
          textStream: (async function* (): AsyncGenerator<string> {
            yield 'partial ';
          })(),
          text: Promise.reject(boom),
          usage: Promise.reject(boom),
          finishReason: Promise.reject(boom),
          toolCalls: Promise.reject(boom),
        };
      },
      supportsTools: () => true,
      supportsStreaming: () => true,
      getModels: async () => [],
    };

    const stream = await withRetry(provider, { ...fast, maxRetries: 3 }).stream(request);
    await expect(collect(stream.fullStream)).rejects.toBe(boom);
    expect(calls).toHaveLength(1);
  });

  it('delegates name, defaultModel and capabilities to the wrapped provider', async () => {
    const { provider } = flaky([]);
    const wrapped = withRetry(provider);

    expect(wrapped.name).toBe('flaky');
    expect(wrapped.defaultModel).toBe('flaky-model');
    expect(wrapped.supportsTools('x')).toBe(true);
    expect(wrapped.supportsStreaming('x')).toBe(true);
    await expect(wrapped.getModels()).resolves.toEqual(['flaky-model']);
  });
});

describe('resilientProvider', () => {
  it("applies the config's maxRetries and per-attempt timeout", async () => {
    const slow = new MockLLMProvider({ delay: 1_000 });
    const generate = vi.spyOn(slow, 'generate');

    await expect(resilientProvider(slow, { maxRetries: 1, timeout: 5 }).generate(request)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(generate).toHaveBeenCalledTimes(2);
  });
});

describe('withFallback', () => {
  it('switches to the next provider on failure and reports it', async () => {
    const primaryError = apiError(401);
    const primary = flaky([primaryError], 'primary');
    const backup = flaky([], 'backup');
    const onFallback = vi.fn();
    const provider = withFallback([primary.provider, backup.provider], { onFallback });

    expect(provider.name).toBe('primary');
    const result = await provider.generate({ ...request, model: provider.defaultModel });

    expect(result.text).toBe('backup ok');
    expect(onFallback).toHaveBeenCalledWith({ from: 'primary', to: 'backup', error: primaryError });
    expect(result.servedBy).toEqual({ provider: 'backup', model: 'backup-model' });
    // the wrapper itself keeps reporting the first provider
    expect(provider.name).toBe('primary');
    expect(provider.defaultModel).toBe('primary-model');
    // each provider ran on its own default model
    expect(primary.calls[0].model).toBeUndefined();
    expect(backup.calls[0].model).toBeUndefined();
  });

  it('starts every call with the first provider and forwards an explicit model to it only', async () => {
    const primary = flaky([apiError(500)], 'primary');
    const backup = flaky([], 'backup');
    const provider = withFallback([primary.provider, backup.provider]);
    await provider.generate(request);

    const result = await provider.generate({ ...request, model: 'gpt-x' });

    expect(result.text).toBe('primary ok');
    expect(primary.calls[1].model).toBe('gpt-x');
    expect(result.servedBy).toEqual({ provider: 'primary', model: 'gpt-x' });
  });

  it('rethrows the last error when every provider fails', async () => {
    const last = apiError(503);
    const provider = withFallback([flaky([apiError(500)], 'a').provider, flaky([last], 'b').provider]);

    await expect(provider.generate(request)).rejects.toBe(last);
  });

  it('does not fall back when fallbackOn says no or the call was aborted', async () => {
    const first = flaky([apiError(500), apiError(500)], 'a');
    const second = flaky([], 'b');
    const noFallback = withFallback([first.provider, second.provider], { fallbackOn: () => false });
    await expect(noFallback.generate(request)).rejects.toMatchObject({ statusCode: 500 });

    const controller = new AbortController();
    const aborting = withFallback([
      { ...first.provider, generate: async () => (controller.abort(), Promise.reject(apiError(500))) },
      second.provider,
    ]);
    await expect(aborting.generate({ ...request, signal: controller.signal })).rejects.toMatchObject({
      statusCode: 500,
    });
    expect(second.calls).toHaveLength(0);
  });

  it('composes with withRetry and covers stream()', async () => {
    const a = flaky([apiError(503), apiError(503), apiError(503)], 'a');
    const b = flaky([apiError(429)], 'b');
    const onFallback = vi.fn();
    const provider = withFallback([withRetry(a.provider, fast), withRetry(b.provider, fast)], { onFallback });

    const stream = await provider.stream(request);

    await expect(stream.text).resolves.toBe('b ok');
    expect(a.calls).toHaveLength(3);
    expect(b.calls).toHaveLength(2);
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ from: 'a', to: 'b' }));
    expect(provider.supportsTools('x')).toBe(true);
    expect(provider.supportsStreaming('x')).toBe(true);
    await expect(provider.getModels()).resolves.toEqual(['a-model']);
  });

  it('falls back when a stream() fails inside the stream before its first chunk (LOU-R6)', async () => {
    const primary = flakyStream([apiError(503)], 'primary');
    const backup = flakyStream([], 'backup');
    const onFallback = vi.fn();
    const provider = withFallback([primary.provider, backup.provider], { onFallback });

    const stream = await provider.stream(request);
    const chunks = await collect(stream.fullStream);

    expect(textOf(chunks)).toBe('backup ok');
    expect(stream.servedBy).toEqual({ provider: 'backup', model: 'backup-model' });
    expect(primary.calls).toHaveLength(1);
    expect(backup.calls).toHaveLength(1);
    expect(onFallback).toHaveBeenCalledWith({ from: 'primary', to: 'backup', error: expect.objectContaining({ statusCode: 503 }) });
  });

  it('composes with withRetry: in-stream failures are retried, then the next provider serves (LOU-R6)', async () => {
    const a = flakyStream([apiError(503), apiError(503), apiError(503)], 'a');
    const b = flakyStream([apiError(503)], 'b');
    const onFallback = vi.fn();
    const provider = withFallback([withRetry(a.provider, fast), withRetry(b.provider, fast)], { onFallback });

    const stream = await provider.stream(request);
    const chunks = await collect(stream.fullStream);

    expect(textOf(chunks)).toBe('b ok');
    expect(a.calls).toHaveLength(3);
    expect(b.calls).toHaveLength(2);
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ from: 'a', to: 'b' }));
  });

  it('needs at least one provider', () => {
    expect(() => withFallback([])).toThrow('at least one provider');
  });

  it('keeps fallback state per call: concurrent calls report their own switch and serving model (A9)', async () => {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const seen: Record<string, Array<string | undefined>> = { primary: [], backup: [] };
    const timed = (name: string, defaultModel: string, behave: (prompt: string) => Promise<void>): LLMProvider => ({
      name,
      defaultModel,
      generate: async (call) => {
        seen[name].push(call.model);
        const prompt = String(call.messages.at(-1)?.content);
        await behave(prompt);
        return { text: `${name}:${prompt}`, finishReason: 'stop', usage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 } };
      },
      stream: async () => Promise.reject(new Error('n/a')),
      supportsTools: () => true,
      supportsStreaming: () => false,
      getModels: async () => [defaultModel],
    });
    // A fails after 10 ms and B after 40 ms (while A is on the backup); C starts at 60 ms and the
    // primary serves it before the backup answers A and B.
    const primary = timed('primary', 'gpt-4o-mini', async (prompt) => {
      await sleep(prompt === 'A' ? 10 : prompt === 'B' ? 40 : 5);
      if (prompt !== 'C') throw apiError(503);
    });
    const backup = timed('backup', 'gpt-4o', () => sleep(100));
    const onFallback = vi.fn();
    const provider = withFallback([primary, backup], { onFallback });
    const agent = createAgent({ provider, instructions: 'x', retry: false });

    const [a, b, c] = await Promise.all([
      agent.send('A'),
      agent.send('B'),
      sleep(60).then(() => agent.send('C')),
    ]);

    expect([a.text, b.text, c.text]).toEqual(['backup:A', 'backup:B', 'primary:C']);
    expect(onFallback.mock.calls.map(([info]) => `${info.from}->${info.to}`)).toEqual(['primary->backup', 'primary->backup']);
    // the primary always ran on its own default model; C was never sent the backup's model
    expect(seen.primary).toEqual([undefined, undefined, undefined]);
    expect(seen.backup).toEqual([undefined, undefined]);
    // usage and cost are booked under the model that served each call
    expect(Object.keys(a.usage.byModel)).toEqual(['gpt-4o']);
    expect(Object.keys(b.usage.byModel)).toEqual(['gpt-4o']);
    expect(Object.keys(c.usage.byModel)).toEqual(['gpt-4o-mini']);
    expect(a.usage.costUsd).toBeCloseTo(estimateCost({ inputTokens: 1000, outputTokens: 1000 }, 'gpt-4o')!);
    expect(a.usage.costUsd).toBeGreaterThan(c.usage.costUsd!);
  });
});
