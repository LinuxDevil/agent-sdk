/**
 * Eve CORE-F13: a `send()` / `stream()` call's own `maxSteps` and
 * `instructions` (appended to the agent's), validated like createAgent's.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { memoryStore } from '../storage/agentStore';
import { textOf } from '../providers/content';
import type { Message } from '../providers/llm';

const ping = defineTool({ name: 'ping', description: 'Ping', input: z.object({}), execute: async () => 'pong' });
const systemOf = (messages: Message[]) => messages.filter((message) => message.role === 'system').map((message) => textOf(message));

describe('per-call maxSteps (Eve CORE-F13)', () => {
  it("a call's maxSteps replaces the agent's for that run only", async () => {
    const model = mockModel([{ toolCalls: [{ name: 'ping' }] }], { onExhausted: 'repeat-last' });
    const agent = createAgent({ provider: model, tools: [ping], maxSteps: 10 });

    const short = await agent.send('go', { maxSteps: 2 });
    expect(short.finishReason).toBe('max-steps');
    expect(model.calls).toHaveLength(2);

    model.calls.length = 0;
    const long = await agent.send('go');
    expect(long.finishReason).toBe('max-steps');
    expect(model.calls).toHaveLength(10);
  });

  it('stream() takes it too', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'ping' }] }], { onExhausted: 'repeat-last' });
    const result = await createAgent({ provider: model, tools: [ping] }).stream('go', { maxSteps: 1 }).result;
    expect(result.finishReason).toBe('max-steps');
    expect(model.calls).toHaveLength(1);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects maxSteps %s with LOUSHO_CONFIG_INVALID before any model call', async (maxSteps) => {
    const model = mockModel(['x']);
    const agent = createAgent({ provider: model });
    await expect(agent.send('go', { maxSteps })).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID', field: 'maxSteps' });
    expect(() => agent.stream('go', { maxSteps })).toThrow(/send: 'maxSteps' must be a whole number >= 1/);
    expect(model.calls).toHaveLength(0);
  });
});

describe('per-call instructions (Eve CORE-F13)', () => {
  it("are appended to the agent's system prompt on every call of the run, not stored in the transcript", async () => {
    const model = mockModel([{ toolCalls: [{ name: 'ping' }] }, 'Bonjour.']);
    const agent = createAgent({ provider: model, tools: [ping], instructions: 'You are terse.' });

    const result = await agent.send('hi', { instructions: 'Answer in French.' });

    expect(model.calls).toHaveLength(2);
    for (const call of model.calls) expect(systemOf(call.messages)).toEqual(['You are terse.\n\nAnswer in French.']);
    expect(systemOf(result.messages)).toEqual(['You are terse.']);
  });

  it('apply to the call they are passed to: a later call on the same sessionId runs without them', async () => {
    const model = mockModel(['one', 'two']);
    const agent = createAgent({ provider: model, instructions: 'Base.', store: memoryStore() });

    await agent.send('first', { sessionId: 's1', instructions: 'Extra.' });
    await agent.send('second', { sessionId: 's1' });

    expect(systemOf(model.calls[0].messages)).toEqual(['Base.\n\nExtra.']);
    expect(systemOf(model.calls[1].messages)).toEqual(['Base.']);
  });

  it('stream() takes them too, and a non-string is rejected with LOUSHO_CONFIG_INVALID', async () => {
    const model = mockModel(['ok']);
    const agent = createAgent({ provider: model, instructions: 'Base.' });

    await agent.stream('hi', { instructions: 'Be brief.' }).result;
    expect(systemOf(model.calls[0].messages)).toEqual(['Base.\n\nBe brief.']);

    await expect(agent.send('hi', { instructions: 42 as never })).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID', field: 'instructions' });
  });
});
