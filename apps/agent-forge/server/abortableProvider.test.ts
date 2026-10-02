import { describe, expect, it } from 'vitest';
import { MockLLMProvider } from '@lousho/build-ai-agent';
import { RunAbortedError, withAbortSignal } from './abortableProvider';

const request = { model: 'mock-1', messages: [{ role: 'user' as const, content: 'hi' }] };

describe('withAbortSignal (M9: streamed calls)', () => {
  it('passes a stream through chunk by chunk when not stopped', async () => {
    const provider = withAbortSignal(new MockLLMProvider({ name: 'mock' }), new AbortController().signal);
    const streamed = await provider.stream(request);
    const deltas: string[] = [];
    for await (const chunk of streamed.fullStream) if (chunk.type === 'text-delta') deltas.push(chunk.textDelta ?? '');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(await streamed.text);
  });

  it('throws RunAbortedError from a stream stopped while it is read', async () => {
    const controller = new AbortController();
    const provider = withAbortSignal(new MockLLMProvider({ name: 'mock' }), controller.signal);
    const streamed = await provider.stream(request);
    const read = async () => {
      for await (const _chunk of streamed.fullStream) controller.abort();
    };
    await expect(read()).rejects.toBeInstanceOf(RunAbortedError);
  });
});
