/**
 * LOU-V7.2: createAgent({ retry, fallbackModels }) and the typed
 * `provider.retry` / `provider.fallback` stream events. No network: the
 * registry's create() is stubbed, as in createAgent.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';
import { createAgent } from './createAgent';
import { LLMProviderRegistry, type LLMProvider, type LLMProviderConfig, type StreamChunk } from './providers/llm';
import { mockModel, type MockModel } from './testing';
import type { AgentEvent, AgentRun } from './execution';

const ENV_VARS = ['LOUSHO_MODEL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_BASE_URL'];

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

/** `model` under another provider name, so a fallback is visible in events. */
function named(model: MockModel, name: string): LLMProvider {
  return {
    name,
    defaultModel: model.defaultModel,
    generate: (call) => model.generate(call),
    stream: (call) => model.stream(call),
    supportsTools: (id) => model.supportsTools(id),
    supportsStreaming: (id) => model.supportsStreaming(id),
    getModels: () => model.getModels(),
  };
}

/**
 * `provider` whose stream() resolves but whose stream fails on its first
 * read `failures` times, then delegates - the way streaming providers
 * report a request error inside the stream (LOU-R6).
 */
function failInsideStream(provider: LLMProvider, failures: unknown[]): LLMProvider {
  const inner = provider.stream.bind(provider);
  return {
    ...provider,
    stream: async (call) => {
      const failure = failures.shift();
      if (failure === undefined) return inner(call);
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
  };
}

/** Stubs the registry: each provider name resolves to the given provider; returns the configs it was built with. */
function stubRegistry(providers: Record<string, LLMProvider>): Array<[string, LLMProviderConfig]> {
  const created: Array<[string, LLMProviderConfig]> = [];
  vi.spyOn(LLMProviderRegistry, 'create').mockImplementation((name, config) => {
    created.push([name, config]);
    return providers[name];
  });
  return created;
}

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

const fast = { backoff: { initialMs: 1, jitter: false } };

describe('createAgent retry and fallbackModels (LOU-V7.2)', () => {
  beforeEach(() => {
    for (const name of ENV_VARS) vi.stubEnv(name, '');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('retries by default (maxRetries 2) with the ai SDK retries off, and streams provider.retry', async () => {
    const model = mockModel([{ error: apiError(429, { 'retry-after': '0' }) }, 'recovered']);
    const created = stubRegistry({ openai: named(model, 'openai') });
    const agent = createAgent({ model: 'openai/gpt-4o-mini' });

    const run = agent.stream('hi');
    const events = await collect(run);

    expect(created).toEqual([['openai', { maxRetries: 0, defaultModel: 'gpt-4o-mini', apiKey: 'sk-openai' }]]);
    expect((await run.result).text).toBe('recovered');
    expect(model.calls).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual([
      'run.start',
      'step.start',
      'provider.retry',
      'text.delta',
      'text.done',
      'step.done',
      'run.done',
    ]);
    expect(events[2]).toMatchObject({
      type: 'provider.retry',
      attempt: 1,
      maxRetries: 2,
      delayMs: 0,
      error: { message: 'HTTP 429', category: 'rate-limit' },
      provider: 'openai',
    });
    expect(JSON.parse(JSON.stringify(events[2]))).toEqual(events[2]);
  });

  it('send() retries too and returns the final result', async () => {
    const model = mockModel([{ error: apiError(503) }, { error: apiError(502) }, 'third time']);
    stubRegistry({ openai: named(model, 'openai') });

    const result = await createAgent({ model: 'openai/gpt-4o-mini', retry: fast }).send('hi');

    expect(result.text).toBe('third time');
    expect(model.calls).toHaveLength(3);
  });

  it('retry: false fails fast', async () => {
    const model = mockModel([{ error: apiError(503) }, 'never reached']);
    const created = stubRegistry({ openai: named(model, 'openai') });

    const agent = createAgent({ model: 'openai/gpt-4o-mini', retry: false });

    await expect(agent.send('hi')).rejects.toThrow();
    expect(model.calls).toHaveLength(1);
    expect(created[0][1].maxRetries).toBe(0);
  });

  it('fallbackModels: switches to the next model after the retries and streams provider.fallback', async () => {
    const primary = mockModel([{ error: apiError(503) }, { error: apiError(503) }]);
    const fallback = mockModel(['from the fallback'], { defaultModel: 'claude-3-5-haiku-latest' });
    const created = stubRegistry({ openai: named(primary, 'openai'), anthropic: named(fallback, 'anthropic') });
    const agent = createAgent({
      model: 'openai/gpt-4o-mini',
      fallbackModels: ['anthropic/claude-3-5-haiku-latest'],
      retry: { ...fast, maxRetries: 1 },
    });

    const run = agent.stream('hi');
    const events = await collect(run);

    expect((await run.result).text).toBe('from the fallback');
    expect(created.map(([name, config]) => [name, config.maxRetries])).toEqual([
      ['openai', 0],
      ['anthropic', 0],
    ]);
    expect(events.filter((e) => e.type.startsWith('provider.'))).toMatchObject([
      { type: 'provider.retry', attempt: 1, maxRetries: 1, provider: 'openai', error: { message: 'HTTP 503' } },
      { type: 'provider.fallback', from: 'openai', to: 'anthropic', error: { message: 'HTTP 503' } },
    ]);
    expect(events.find((e) => e.type === 'provider.retry')).not.toHaveProperty('error.category'); // a 5xx is 'unknown'
    expect(fallback.lastCall?.model).toBeUndefined(); // the fallback runs on its own default model
  });

  it('fallbackModels also work with a provider instance', async () => {
    const primary = mockModel([{ error: apiError(401) }]);
    const fallback = mockModel(['fallback answer']);
    stubRegistry({ anthropic: named(fallback, 'anthropic') });

    const result = await createAgent({ provider: primary, fallbackModels: ['anthropic/claude-3-5-haiku-latest'] }).send('hi');

    expect(result.text).toBe('fallback answer');
    expect(primary.calls).toHaveLength(1);
  });

  it('a provider instance is retried only when retry is set', async () => {
    const plain = mockModel([{ error: apiError(503) }, 'unused']);
    await expect(createAgent({ provider: plain }).send('hi')).rejects.toThrow();
    expect(plain.calls).toHaveLength(1);

    const retried = mockModel([{ error: apiError(503) }, 'retried']);
    const run = createAgent({ provider: retried, retry: fast }).stream('hi');
    const events = await collect(run);
    expect((await run.result).text).toBe('retried');
    expect(events.some((e) => e.type === 'provider.retry' && e.provider === 'mock')).toBe(true);
  });

  it('stream(): retries a failure reported inside the stream and emits provider.retry (LOU-R6)', async () => {
    const model = mockModel(['recovered']);
    const provider = failInsideStream(named(model, 'openai'), [apiError(503)]);

    const run = createAgent({ provider, retry: fast }).stream('hi');
    const events = await collect(run);

    expect((await run.result).text).toBe('recovered');
    expect(events.find((e) => e.type === 'provider.retry')).toMatchObject({ attempt: 1, provider: 'openai' });
    expect(events.map((e) => e.type)).toContain('text.delta');
  });

  it('stream(): falls back on a failure reported inside the stream and emits provider.fallback (LOU-R6)', async () => {
    const primary = failInsideStream(named(mockModel([]), 'openai'), [apiError(503), apiError(503), apiError(503)]);
    const fallback = mockModel(['from the fallback'], { defaultModel: 'claude-3-5-haiku-latest' });
    stubRegistry({ anthropic: named(fallback, 'anthropic') });

    const run = createAgent({ provider: primary, retry: fast, fallbackModels: ['anthropic/claude-3-5-haiku-latest'] }).stream('hi');
    const events = await collect(run);

    expect((await run.result).text).toBe('from the fallback');
    expect(events.find((e) => e.type === 'provider.fallback')).toMatchObject({ from: 'openai', to: 'anthropic' });
  });

  it('stream(): a failure mid-stream, after the first chunk, is not retried (LOU-R6)', async () => {
    const model = mockModel(['unused']);
    const inner = named(model, 'openai');
    const boom = apiError(503);
    const provider: LLMProvider = {
      ...inner,
      stream: async (call) => {
        const streamed = await inner.stream(call);
        const fullStream = (async function* (): AsyncGenerator<StreamChunk> {
          yield { type: 'text-delta', textDelta: 'partial ' };
          throw boom;
        })();
        return { ...streamed, fullStream };
      },
    };

    const run = createAgent({ provider, retry: fast }).stream('hi');
    const events = await collect(run);
    await expect(run.result).rejects.toMatchObject({ message: 'HTTP 503' });
    expect(events.filter((e) => e.type === 'provider.retry')).toHaveLength(0);
    expect(model.calls).toHaveLength(1);
  });

  it('session.stream() carries the provider events', async () => {
    const model = mockModel([{ error: apiError(503) }, 'session answer']);
    stubRegistry({ openai: named(model, 'openai') });
    const session = createAgent({ model: 'openai/gpt-4o-mini', retry: fast }).session();

    const events = await collect(session.stream('hi'));

    expect(events.find((e) => e.type === 'provider.retry')).toMatchObject({ attempt: 1, provider: 'openai' });
    expect(events.at(-1)).toMatchObject({ type: 'run.done', text: 'session answer' });
  });

  it('throws at creation for a bad fallback model string', () => {
    stubRegistry({ openai: mockModel([]) });
    expect(() => createAgent({ model: 'openai/gpt-4o-mini', fallbackModels: ['nope'] })).toThrow(/createAgent: expected/);
  });
});
