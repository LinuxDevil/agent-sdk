/**
 * LOU-R8: reasoning on the OpenRouter provider. The request body carries the
 * unified `reasoning` field, and OpenRouter reports the reasoning back in
 * fields `@ai-sdk/openai` drops (`message`/`delta.reasoning`,
 * `reasoning_details`, `usage.completion_tokens_details.reasoning_tokens`):
 * the provider reads them from the response body itself and surfaces them as
 * the SDK's own reasoning - `reasoning.*` stream events, `reasoning` blocks
 * and `usage.reasoningTokens`. Responses are shaped like OpenRouter's Chat
 * Completions ones; fetch is stubbed. Runs on every `ai` major.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider } from './OpenRouterProvider';
import { createAgent } from '../createAgent';

const USAGE = { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 };

function completion(message: Record<string, unknown>, usage: Record<string, unknown> = {}) {
  return {
    id: 'gen-1730000002-rsn',
    object: 'chat.completion',
    created: 1730000002,
    model: 'deepseek/deepseek-r1',
    choices: [{ index: 0, message: { role: 'assistant', content: 'The answer.', ...message }, finish_reason: 'stop' }],
    usage: { ...USAGE, ...usage },
  };
}

function sse(chunks: unknown[]): Response {
  const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A streamed reply that reasons in two pieces (a signed one), then answers and reports its token counts. */
function streamedReasoning(): Response {
  const base = { id: 'gen-1730000003-rsn', object: 'chat.completion.chunk', created: 1730000003, model: 'deepseek/deepseek-r1' };
  return sse([
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', reasoning: 'Let me ' }, finish_reason: null }] },
    {
      ...base,
      choices: [{ index: 0, delta: { reasoning_details: [{ type: 'reasoning.text', text: 'think.', signature: 'sig-1' }] }, finish_reason: null }],
    },
    { ...base, choices: [{ index: 0, delta: { content: 'The answer.' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { ...base, choices: [], usage: { ...USAGE, completion_tokens_details: { reasoning_tokens: 5 } } },
  ]);
}

function provider(): OpenRouterProvider {
  return new OpenRouterProvider({ name: 'openrouter', apiKey: 'test-key', maxRetries: 0, defaultModel: 'deepseek/deepseek-r1' });
}

const messages = [{ role: 'user' as const, content: 'Think, then answer.' }];
const thinking = { messages, model: 'deepseek/deepseek-r1', reasoning: 'low' as const };

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenRouter reasoning: generate()', () => {
  it('returns the flat `reasoning` text as blocks, with the reasoning token count in usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(completion({ reasoning: 'I thought about it.' }, { completion_tokens_details: { reasoning_tokens: 9 } }))));
    const result = await provider().generate(thinking);
    expect(result.reasoning).toEqual([{ text: 'I thought about it.' }]);
    expect(result.usage?.reasoningTokens).toBe(9);
    expect(result.usage?.promptTokens).toBe(40);
    expect(result.text).toBe('The answer.');
  });

  it('returns `reasoning_details` as one block per entry, signatures and encrypted data kept', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json(
        completion({
          reasoning_details: [
            { type: 'reasoning.text', text: 'First. ', signature: 'sig-a' },
            { type: 'reasoning.text', text: 'Second.' },
            { type: 'reasoning.encrypted', data: 'opaque-blob' },
            { type: 'reasoning.summary', summary: 'In short.' },
          ],
        })
      )
    ));
    const result = await provider().generate(thinking);
    expect(result.reasoning).toEqual([
      { text: 'First. ', signature: 'sig-a' },
      { text: 'Second.' },
      { text: '', redactedData: 'opaque-blob' },
      { text: 'In short.' },
    ]);
  });

  it('reports no reasoning when the response carries none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(completion({}))));
    const result = await provider().generate(thinking);
    expect(result.reasoning).toBeUndefined();
  });
});

describe('OpenRouter reasoning: stream()', () => {
  it('emits reasoning-delta / reasoning-end chunks before finish, and the token count on its usage', async () => {
    vi.stubGlobal('fetch', vi.fn(streamedReasoning));
    const streamed = await provider().stream(thinking);
    const chunks = await collect(streamed.fullStream);
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'text-delta',
      'reasoning-delta',
      'reasoning-delta',
      'reasoning-end',
      'finish',
    ]);
    expect(chunks[1]).toEqual({ type: 'reasoning-delta', textDelta: 'Let me ' });
    expect(chunks[2]).toEqual({ type: 'reasoning-delta', textDelta: 'think.' });
    expect(chunks[3]).toEqual({ type: 'reasoning-end', reasoning: { signature: 'sig-1' } });
    expect(chunks.at(-1)!.usage?.reasoningTokens).toBe(5);
    expect(await streamed.usage).toMatchObject({ reasoningTokens: 5 });
  });

  it('a call without request changes streams unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(streamedReasoning));
    const streamed = await provider().stream({ messages, model: 'deepseek/deepseek-r1' });
    const types = (await collect(streamed.fullStream)).map((chunk) => chunk.type);
    expect(types).not.toContain('reasoning-delta');
  });
});

describe('OpenRouter reasoning through an agent', () => {
  it('emits reasoning.* events and fills result.reasoning and usage.reasoningTokens', async () => {
    vi.stubGlobal('fetch', vi.fn(streamedReasoning));
    const agent = createAgent({
      provider: provider(),
      model: 'deepseek/deepseek-r1',
      instructions: 'x',
      reasoning: 'low',
      maxSteps: 1,
    });
    const run = agent.stream('Think, then answer.');
    const events = await collect(run);
    const result = await run.result;

    expect(events.filter((e) => e.type.startsWith('reasoning.')).map((e) => [e.type, 'text' in e ? e.text : undefined])).toEqual([
      ['reasoning.start', undefined],
      ['reasoning.delta', 'Let me '],
      ['reasoning.delta', 'think.'],
      ['reasoning.done', 'Let me think.'],
    ]);
    expect(result.reasoning).toBe('Let me think.');
    expect(result.text).toBe('The answer.');
    expect(result.usage.reasoningTokens).toBe(5);
  });
});
