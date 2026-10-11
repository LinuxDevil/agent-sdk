/**
 * Run-level edge cases from the core runtime audit: a stream's unknown finish
 * reason, the text of an aborted stream, an empty input, and a reply that
 * ends 'tool_calls' without any call.
 */
import { describe, expect, it } from 'vitest';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import type { LLMProvider, StreamChunk, StreamResult } from '../providers';

/** A streaming provider whose stream yields `chunks`, then (with `hang`) waits for the request's signal. */
function streamingProvider(chunks: StreamChunk[], hang = false): LLMProvider {
  const stream = async ({ signal }: { signal?: AbortSignal }): Promise<StreamResult> => {
    const fullStream = (async function* (): AsyncGenerator<StreamChunk> {
      yield* chunks;
      if (hang) await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
    })();
    return {
      fullStream,
      textStream: (async function* () {})(),
      text: Promise.resolve(''),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    };
  };
  return {
    name: 'streaming',
    defaultModel: 'm',
    generate: async () => ({ text: '', finishReason: 'stop' }),
    stream,
    supportsTools: () => true,
    supportsStreaming: () => true,
    getModels: async () => ['m'],
  };
}

describe('run edge cases', () => {
  it("a streamed step with an unknown finish reason ends 'other', like send(), with no error event", async () => {
    const provider = streamingProvider([
      { type: 'text-delta', textDelta: 'hey' },
      { type: 'finish', finishReason: 'weird_new_reason', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    ]);
    const run = createAgent({ provider, instructions: 'x', retry: false }).stream('hi');
    const events: string[] = [];
    for await (const event of run) events.push(event.type === 'run.done' ? `run.done:${event.finishReason}` : event.type);

    expect((await run.result).text).toBe('hey');
    expect(events).not.toContain('error');
    expect(events.at(-1)).not.toBe('run.done:error');
  });

  it('an aborted stream leaves the text it streamed as result.text', async () => {
    const controller = new AbortController();
    const provider = streamingProvider([{ type: 'text-delta', textDelta: 'partial answer' }], true);
    const run = createAgent({ provider, instructions: 'x', retry: false }).stream('hi', { signal: controller.signal });
    for await (const event of run) if (event.type === 'text.delta') controller.abort();
    const result = await run.result;

    expect(result.finishReason).toBe('aborted');
    expect(result.text).toBe('partial answer');
  });

  it('an empty message list is refused instead of sending a request with no user turn', async () => {
    const model = mockModel(['never']);
    await expect(createAgent({ provider: model, instructions: 'x' }).send([])).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
    expect(model.calls).toHaveLength(0);
  });

  it("a reply that ends 'tool_calls' without a call ends the run 'stop'", async () => {
    const result = await createAgent({ provider: mockModel([{ text: 'hmm', finishReason: 'tool_calls' }]), instructions: 'x' }).send('hi');
    expect(result).toMatchObject({ text: 'hmm', finishReason: 'stop' });
  });
});
