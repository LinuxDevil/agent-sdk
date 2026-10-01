import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { mockModel } from './index';
import { createAgent } from '../createAgent';
import type { GenerateOptions, StreamChunk } from '../providers/llm';

const request = (content = 'hi'): GenerateOptions => ({ messages: [{ role: 'user', content }] });

describe('mockModel turns', () => {
  it('treats a bare string as { text } and reports no usage by default', async () => {
    const model = mockModel(['Hello!']);

    const result = await model.generate(request());

    expect(result).toEqual({
      text: 'Hello!',
      finishReason: 'stop',
    });
    expect(result.usage).toBeUndefined();
  });

  it('emits tool calls with stable generated ids and JSON-encoded args', async () => {
    const model = mockModel([
      { toolCalls: [{ name: 'a', args: { x: 1 } }, { name: 'b' }] },
      { toolCalls: [{ name: 'c', id: 'custom' }, { name: 'd' }] },
    ]);

    const first = await model.generate(request());
    const second = await model.generate(request());

    expect(first.finishReason).toBe('tool_calls');
    expect(first.toolCalls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{"x":1}' } },
      { id: 'call_2', type: 'function', function: { name: 'b', arguments: '{}' } },
    ]);
    expect(second.toolCalls?.map((c) => c.id)).toEqual(['custom', 'call_3']);
  });

  it('honours usage, finishReason, text alongside tool calls', async () => {
    const model = mockModel([
      {
        text: 'thinking',
        toolCalls: [{ name: 't' }],
        usage: { inputTokens: 3, outputTokens: 4 },
        finishReason: 'length',
      },
    ]);

    const result = await model.generate(request());

    expect(result.text).toBe('thinking');
    expect(result.finishReason).toBe('length');
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 });
  });

  it('rejects with the scripted error and still records the call', async () => {
    const boom = new Error('rate limited');
    const model = mockModel([{ error: boom }]);

    await expect(model.generate(request())).rejects.toBe(boom);
    expect(model.calls).toHaveLength(1);
  });

  it('builds dynamic turns from the request (sync and async)', async () => {
    const model = mockModel([
      (req) => `echo: ${req.messages.at(-1)?.content}`,
      async (req) => ({ text: `n=${req.messages.length}` }),
    ]);

    expect((await model.generate(request('ping'))).text).toBe('echo: ping');
    expect((await model.generate(request())).text).toBe('n=1');
  });

  it('waits delayMs before answering', async () => {
    vi.useFakeTimers();
    try {
      const model = mockModel([{ text: 'late', delayMs: 50 }]);
      let settled = false;
      const pending = model.generate(request()).then((r) => {
        settled = true;
        return r;
      });

      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).text).toBe('late');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('mockModel recording', () => {
  it('records deep-frozen snapshots that later mutation cannot change', async () => {
    const model = mockModel(['a', 'b']);
    const messages = [{ role: 'user' as const, content: 'first' }];

    await model.generate({ messages, model: 'm', temperature: 0.2 });
    messages.push({ role: 'user', content: 'mutated' });
    await model.generate(request('second'));

    expect(model.calls).toHaveLength(2);
    expect(model.calls[0].messages).toEqual([{ role: 'user', content: 'first' }]);
    expect(model.calls[0]).toMatchObject({ model: 'm', temperature: 0.2 });
    expect(model.lastCall).toBe(model.calls[1]);
    expect(Object.isFrozen(model.calls[0])).toBe(true);
    expect(Object.isFrozen(model.calls[0].messages)).toBe(true);
    expect(Object.isFrozen(model.calls[0].messages[0])).toBe(true);
  });

  it('reset() rewinds the script, calls and generated ids', async () => {
    const model = mockModel([{ toolCalls: [{ name: 't' }] }]);
    await model.generate(request());

    model.reset();

    expect(model.calls).toHaveLength(0);
    expect(model.lastCall).toBeUndefined();
    const again = await model.generate(request());
    expect(again.toolCalls?.[0].id).toBe('call_1');
  });
});

describe('mockModel exhaustion', () => {
  it('throws an actionable error naming the unexpected call and last message', async () => {
    const model = mockModel(['only']);
    await model.generate(request());

    const error = await model.generate(request('what next?')).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('call #2');
    expect(message).toContain('1 turn');
    expect(message).toContain('user: "what next?"');
    expect(message).toContain('Add another turn');
    expect(message).toContain("onExhausted: 'repeat-last'");
    expect(model.calls).toHaveLength(2);
  });

  it("replays the final turn with onExhausted: 'repeat-last'", async () => {
    const model = mockModel(['a', 'b'], { onExhausted: 'repeat-last' });

    const texts = [];
    for (let i = 0; i < 4; i++) texts.push((await model.generate(request())).text);

    expect(texts).toEqual(['a', 'b', 'b', 'b']);
  });

  it('still throws on an empty script even with repeat-last', async () => {
    const model = mockModel([], { onExhausted: 'repeat-last' });
    await expect(model.generate(request())).rejects.toThrow(/call #1/);
  });

  it('assertExhausted() throws while turns remain and passes once consumed', async () => {
    const model = mockModel(['a', 'b']);
    await model.generate(request());

    expect(() => model.assertExhausted()).toThrow(/1 scripted turn/);
    await model.generate(request());
    expect(() => model.assertExhausted()).not.toThrow();
  });
});

describe('mockModel streaming', () => {
  it('streams the scripted text as chunks that rejoin to the text, then finishes', async () => {
    const model = mockModel([{ text: 'Hello big world', usage: { inputTokens: 1, outputTokens: 2 } }]);

    const result = await model.stream(request());
    const chunks: StreamChunk[] = [];
    for await (const chunk of result.fullStream) chunks.push(chunk);

    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.textDelta);
    expect(deltas).toEqual(['Hello ', 'big ', 'world']);
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', finishReason: 'stop' });
    expect(await result.text).toBe('Hello big world');
    expect(await result.usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    expect(model.calls).toHaveLength(1);
  });

  it('emits tool-call chunks and exposes them on the result', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'lookup', args: { q: 1 } }] }]);

    const result = await model.stream(request());
    const chunks: StreamChunk[] = [];
    for await (const chunk of result.fullStream) chunks.push(chunk);

    expect(chunks.find((c) => c.type === 'tool-call')?.toolCall?.id).toBe('call_1');
    expect(await result.toolCalls).toHaveLength(1);
    expect(await result.finishReason).toBe('tool_calls');
  });

  it('streams textStream and rejects stream() for an error turn', async () => {
    const model = mockModel(['a b', { error: new Error('nope') }]);

    const result = await model.stream(request());
    const parts: string[] = [];
    for await (const part of result.textStream) parts.push(part);
    expect(parts.join('')).toBe('a b');
    await expect(model.stream(request())).rejects.toThrow('nope');
  });
});

describe('mockModel as an agent provider', () => {
  it('drives a tool-call flow end to end', async () => {
    const execute = vi.fn(async (args: { city: string }) => ({ tempC: 21, city: args.city }));
    const model = mockModel([
      { toolCalls: [{ name: 'get_weather', args: { city: 'Paris' } }] },
      { text: 'It is 21°C in Paris.' },
    ]);
    const agent = createAgent({
      prompt: 'You report weather.',
      provider: model,
      tools: {
        get_weather: {
          displayName: 'Get weather',
          tool: {
            description: 'Get the weather for a city',
            parameters: z.object({ city: z.string() }),
            execute,
          },
        },
      },
    });

    const result = await agent.send('Weather in Paris?');

    expect(result.text).toBe('It is 21°C in Paris.');
    expect(execute).toHaveBeenCalledWith({ city: 'Paris' }, expect.anything());
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1].messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call_1' });
    model.assertExhausted();
  });
});
