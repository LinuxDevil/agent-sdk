/**
 * withRateLimit / createRateLimiter (Eve PROV-F14), on fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateOptions, GenerateResult, LLMProvider, StreamChunk } from './llm';
import { MockLLMProvider } from './mock';
import { createRateLimiter, withRateLimit } from './rateLimit';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { ConfigurationError } from '../execution/errors';

const call = (text = 'hi', extra: Partial<GenerateOptions> = {}): GenerateOptions => ({
  messages: [{ role: 'user', content: text }],
  ...extra,
});

const mockOf = (...responses: ConstructorParameters<typeof MockLLMProvider>[0]['responses'] & unknown[]) =>
  new MockLLMProvider({ defaultModel: 'mock', responses });

function fake(name: string, generate: LLMProvider['generate']): LLMProvider {
  return {
    name,
    defaultModel: name,
    generate,
    stream: async () => {
      throw new Error('not used');
    },
    supportsTools: () => true,
    supportsStreaming: () => false,
    getModels: async () => [],
  };
}

/** A provider whose calls stay open until `finish()`, recording peak concurrency. */
function gated() {
  const inner = mockOf('ok');
  const waiting: Array<() => void> = [];
  const stats = { started: 0, active: 0, peak: 0 };
  const provider = fake('gated', async (options) => {
    stats.started++;
    stats.peak = Math.max(stats.peak, ++stats.active);
    await new Promise<void>((resolve) => waiting.push(resolve));
    stats.active--;
    return inner.generate(options);
  });
  return { provider, stats, finish: () => waiting.shift()?.() };
}

describe('withRateLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('caps in-flight calls at maxConcurrent and starts the next as one finishes', async () => {
    const { provider, stats, finish } = gated();
    const limited = withRateLimit(provider, { maxConcurrent: 2 });
    const results = [1, 2, 3, 4].map(() => limited.generate(call()));
    await vi.advanceTimersByTimeAsync(0);
    expect(stats).toMatchObject({ started: 2, active: 2 });
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(stats.started).toBe(3);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    finish();
    await Promise.all(results);
    expect(stats.peak).toBe(2);
    expect(stats.started).toBe(4);
  });

  it('spreads calls over the minute with requestsPerMinute', async () => {
    const mock = mockOf('a');
    const spy = vi.spyOn(mock, 'generate');
    const limited = withRateLimit(mock, { requestsPerMinute: 2 });
    const done = [1, 2, 3].map(() => limited.generate(call()));
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(spy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spy).toHaveBeenCalledTimes(3);
    await Promise.all(done);
  });

  it('holds calls back by their estimated tokens per minute', async () => {
    const mock = fake('t', async () => ({ content: 'a' }) as GenerateResult);
    const spy = vi.spyOn(mock, 'generate');
    const limited = withRateLimit(mock, { tokensPerMinute: 1_000 });
    const big = call('x', { maxTokens: 600 });
    const done = [limited.generate(big), limited.generate(big)];
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy).toHaveBeenCalledTimes(2);
    await Promise.all(done);
  });

  it('runs a call larger than tokensPerMinute alone instead of never', async () => {
    const limited = withRateLimit(mockOf('a'), { tokensPerMinute: 10 });
    await expect(limited.generate(call('x', { maxTokens: 500 }))).resolves.toBeDefined();
  });

  it('re-books a finished call at its reported usage', async () => {
    const reply = { content: 'a', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } as GenerateResult;
    const inner = fake('u', async () => reply);
    const spy = vi.spyOn(inner, 'generate');
    const limited = withRateLimit(inner, { tokensPerMinute: 1_000 });
    const big = call('x', { maxTokens: 900 });
    await limited.generate(big);
    await limited.generate(big); // 900 estimated would have blocked; 2 reported does not
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('serves waiting calls in order', async () => {
    const { provider, finish } = gated();
    const limited = withRateLimit(provider, { maxConcurrent: 1 });
    const order: string[] = [];
    const run = (id: string) => limited.generate(call(id)).then(() => order.push(id));
    const all = [run('a'), run('b'), run('c')];
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(0);
      finish();
    }
    await Promise.all(all);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('removes a queued call that is aborted, without starting it', async () => {
    const { provider, stats, finish } = gated();
    const limiter = createRateLimiter({ maxConcurrent: 1 });
    const limited = withRateLimit(provider, limiter);
    const first = limited.generate(call());
    const controller = new AbortController();
    const queued = limited.generate(call('q', { signal: controller.signal }));
    const rejected = expect(queued).rejects.toThrow('stop');
    await vi.advanceTimersByTimeAsync(0);
    expect(limiter.pending).toBe(1);
    controller.abort(new Error('stop'));
    await rejected;
    expect(limiter.pending).toBe(0);
    finish();
    await first;
    expect(stats.started).toBe(1);
    await expect(limited.generate(call('late', { signal: controller.signal }))).rejects.toThrow('stop');
  });

  it('frees the slot when a call fails', async () => {
    const limiter = createRateLimiter({ maxConcurrent: 1 });
    const limited = withRateLimit(
      fake('f', async () => Promise.reject(new Error('boom'))),
      limiter
    );
    await expect(limited.generate(call())).rejects.toThrow('boom');
    expect(limiter.inFlight).toBe(0);
  });

  it('holds a stream slot until the stream is read to its end', async () => {
    let end!: () => void;
    const ended = new Promise<void>((resolve) => (end = resolve));
    const inner: LLMProvider = {
      ...fake('s', async () => ({ content: 'x' }) as GenerateResult),
      stream: async () => ({
        textStream: (async function* () {})(),
        fullStream: (async function* (): AsyncGenerator<StreamChunk> {
          yield { type: 'text-delta', textDelta: 'a' };
          await ended;
          yield { type: 'finish', finishReason: 'stop' };
        })(),
        text: ended.then(() => 'a'),
        usage: ended.then(() => undefined),
        finishReason: ended.then(() => 'stop'),
        toolCalls: ended.then(() => []),
      }),
    };
    const limiter = createRateLimiter({ maxConcurrent: 1 });
    const limited = withRateLimit(inner, limiter);
    const streamed = await limited.stream(call());
    const second = limited.stream(call());
    await vi.advanceTimersByTimeAsync(0);
    expect(limiter.inFlight).toBe(1);
    expect(limiter.pending).toBe(1);
    end();
    const chunks: StreamChunk[] = [];
    for await (const chunk of streamed.fullStream) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    await second;
    expect(limiter.pending).toBe(0);
  });

  it('rejects invalid limits', () => {
    const mock = mockOf('a');
    expect(() => withRateLimit(mock, { requestsPerMinute: 0 })).toThrow(ConfigurationError);
    expect(() => withRateLimit(mock, { maxConcurrent: 1.5 })).toThrow(ConfigurationError);
    expect(() => withRateLimit(mock, { tokensPerMinute: Number.NaN })).toThrow(ConfigurationError);
  });
});

describe('createAgent({ rateLimit })', () => {
  /** Peak overlap of the sub-agents' model calls, with the lead running two `task` calls at once. */
  async function peakOverlap(rateLimit?: { maxConcurrent: number }) {
    const stats = { active: 0, peak: 0 };
    const inner = mockOf('done');
    const slow = fake('slow', async (options) => {
      stats.peak = Math.max(stats.peak, ++stats.active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      stats.active--;
      return inner.generate(options);
    });
    const worker = createAgent({ provider: slow, description: 'Works', name: 'worker' });
    const task = { name: 'task', args: { agent: 'worker', prompt: 'go', description: 'work' } };
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [task, task] }, 'All done.']),
      subagents: { worker },
      ...(rateLimit && { rateLimit }),
    });
    await lead.send('fan out');
    return stats.peak;
  }

  it('is unbounded without rateLimit', async () => {
    expect(await peakOverlap()).toBe(2);
  });

  it("shares the lead's budget with the sub-agents it runs", async () => {
    expect(await peakOverlap({ maxConcurrent: 1 })).toBe(1);
  });

  it('rejects invalid limits at createAgent()', () => {
    expect(() => createAgent({ provider: mockOf('a'), rateLimit: { maxConcurrent: 0 } })).toThrow(ConfigurationError);
  });
});
