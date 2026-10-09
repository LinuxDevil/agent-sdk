/**
 * Eve CORE-F15: an abort ends the run 'aborted' even when the provider or a
 * tool ignores the signal, mockModel honours the signal, and the result says
 * why it was aborted (`abortReason`).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import type { AgentEvent } from './agentEvents';

describe('abort with a provider that ignores the signal (Eve CORE-F15)', () => {
  it('send() ends promptly as aborted, without the late reply', async () => {
    const agent = createAgent({ provider: mockModel([{ text: 'late', delayMs: 2000, ignoreSignal: true }]) });
    const started = Date.now();
    const result = await agent.send('go', { signal: AbortSignal.timeout(50) });

    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.finishReason).toBe('aborted');
    expect(result.text).toBe('');
    expect(result.abortReason).toMatchObject({ name: 'TimeoutError' });
  });

  it('stream() too, and reports nothing the abandoned call streams afterwards', async () => {
    const agent = createAgent({ provider: mockModel([{ text: 'late reply', delayMs: 300, ignoreSignal: true }]) });
    const controller = new AbortController();
    const run = agent.stream('go', { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const seen: AgentEvent[] = [];
    for await (const event of run) seen.push(event);
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(seen.some((event) => event.type === 'text.delta')).toBe(false);
    expect(seen.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'aborted' });
    expect((await run.result).finishReason).toBe('aborted');
  });

  it('a tool that ignores ctx.signal finishes, then the run ends aborted without another model call', async () => {
    const slow = defineTool({
      name: 'slow',
      description: 'slow',
      input: z.object({}),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return 'ok';
      },
    });
    const model = mockModel([{ toolCalls: [{ name: 'slow' }] }, 'done']);
    const result = await createAgent({ provider: model, tools: [slow] }).send('go', { signal: AbortSignal.timeout(50) });

    expect(result.finishReason).toBe('aborted');
    expect(model.calls).toHaveLength(1);
  });
});

describe('mockModel honours the signal (Eve CORE-F15)', () => {
  it('rejects a delayed turn with the signal reason as soon as it aborts', async () => {
    const model = mockModel([{ text: 'x', delayMs: 2000 }]);
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(new Error('stop now')), 20);

    await expect(model.generate({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal })).rejects.toThrow('stop now');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('rejects an already-aborted request, and stops a stream between chunks', async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(mockModel(['x']).generate({ messages: [], signal: aborted.signal })).rejects.toMatchObject({ name: 'AbortError' });

    const controller = new AbortController();
    const streamed = await mockModel(['one two three']).stream({ messages: [], signal: controller.signal });
    const chunks: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of streamed.fullStream) {
          if (chunk.type === 'text-delta') chunks.push(chunk.textDelta ?? '');
          controller.abort();
        }
      })()
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(chunks).toEqual(['one ']);
  });
});

describe('abortReason (Eve CORE-F15)', () => {
  it('tells a timeout from a cancel and keeps a string reason', async () => {
    const agent = createAgent({ provider: mockModel([{ text: 'x', delayMs: 500 }], { onExhausted: 'repeat-last' }) });

    const cancelled = new AbortController();
    setTimeout(() => cancelled.abort('user left'), 20);
    expect((await agent.send('go', { signal: cancelled.signal })).abortReason).toEqual({ name: 'AbortError', message: 'user left' });

    const plain = new AbortController();
    setTimeout(() => plain.abort(), 20);
    expect((await agent.send('go', { signal: plain.signal })).abortReason?.name).toBe('AbortError');

    expect((await agent.send('go', { signal: AbortSignal.timeout(20) })).abortReason?.name).toBe('TimeoutError');
  });

  it('is absent when the run was not aborted', async () => {
    const result = await createAgent({ provider: mockModel(['hi']) }).send('go');
    expect(result.finishReason).toBe('stop');
    expect(result).not.toHaveProperty('abortReason');
  });
});
