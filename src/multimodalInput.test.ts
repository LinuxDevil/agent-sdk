/**
 * LOU-V12: send() / stream() take an AgentInput (a string, content parts or
 * a Message[]) on agents and sessions, and sessions keep the parts.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from './createAgent';
import { defineTool } from './tools/defineTool';
import { PropagatingToolError } from './execution/AgentExecutor';
import { memoryStore, type AgentStore } from './storage/agentStore';
import { SqliteStore } from './storage/sqlite';
import { mockModel } from './testing';
import { toMessages, type AgentInput } from './providers/content';
import type { ContentPart, Message } from './providers/llm';

const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
const parts: ContentPart[] = [
  { type: 'text', text: 'What is in this photo?' },
  { type: 'image', image: bytes, mimeType: 'image/png' },
];
// mockModel deep-freezes what the provider saw, so calls[i].messages is deeply readonly - not Message[].
const conversation = (messages: readonly { readonly role: string }[]) => messages.filter((m) => m.role !== 'system');

describe('toMessages()', () => {
  it('wraps a string or parts in one user message and passes Message[] through', () => {
    expect(toMessages('Hi')).toEqual([{ role: 'user', content: 'Hi' }]);
    expect(toMessages(parts)).toEqual([{ role: 'user', content: parts }]);
    const messages: Message[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    expect(toMessages(messages)).toBe(messages);
    expect(toMessages([])).toEqual([]);
  });
});

describe('agent.send() / agent.stream() with an AgentInput (LOU-V12)', () => {
  it('send(parts) reaches the provider as one user message with the parts', async () => {
    const model = mockModel(['A cat.']);
    const result = await createAgent({ prompt: 'Describe images.', provider: model }).send(parts);

    expect(result.text).toBe('A cat.');
    expect(conversation(model.calls[0].messages)).toEqual([{ role: 'user', content: parts }]);
  });

  it('send(Message[]) is passed through as the conversation', async () => {
    const model = mockModel(['Paris.']);
    const input: AgentInput = [
      { role: 'user', content: 'Capital of France?' },
      { role: 'assistant', content: 'Let me think.' },
      { role: 'user', content: [{ type: 'text', text: 'Answer now.' }] },
    ];
    await createAgent({ provider: model }).send(input);

    expect(conversation(model.calls[0].messages)).toEqual(input);
  });

  it('stream(parts) sends the parts too', async () => {
    const model = mockModel(['A cat.']);
    const run = createAgent({ provider: model }).stream(parts);

    expect((await run.result).text).toBe('A cat.');
    expect(conversation(model.calls[0].messages)).toEqual([{ role: 'user', content: parts }]);
  });

  it('a durable send(parts, { sessionId }) is finished by agent.resume() with the parts intact', async () => {
    let runs = 0;
    const flaky = defineTool({
      name: 'flaky',
      description: 'dies once',
      input: z.object({}),
      execute: async () => {
        if (++runs === 1) throw new PropagatingToolError('process died');
        return 'ok';
      },
    });
    const store = memoryStore();
    const call = { toolCalls: [{ name: 'flaky', id: 'call_flaky' }] };
    const crashing = createAgent({ provider: mockModel([call]), tools: [flaky], store });
    await expect(crashing.send(parts, { sessionId: 'job' })).rejects.toThrow('process died');

    const model = mockModel(['Done.']);
    const resumed = await createAgent({ provider: model, tools: [flaky], store }).resume('job');

    expect(resumed?.text).toBe('Done.');
    expect(conversation(model.calls[0].messages)[0]).toEqual({ role: 'user', content: parts });
  });
});

const stores: Array<[string, () => AgentStore & { close?: () => void }]> = [
  ['memoryStore()', () => memoryStore()],
  [":memory: SqliteStore", () => new SqliteStore(':memory:')],
];

describe.each(stores)('session.send() with parts through %s (LOU-V12)', (_name, makeStore) => {
  it('keeps the parts in the transcript and shows them to the next turn', async () => {
    const store = makeStore();
    const first = mockModel(['A cat.']);
    await createAgent({ provider: first, store }).session({ id: 'chat' }).send(parts);

    const saved = await store.sessions!.load('chat');
    expect(saved![0]).toEqual({ role: 'user', content: parts });
    expect((saved![0].content as ContentPart[])[1]).toMatchObject({ image: bytes });
    expect((saved![0].content as { image: unknown }[])[1].image).toBeInstanceOf(Uint8Array);

    const second = mockModel(['It is orange.']);
    const session = createAgent({ provider: second, store }).session({ id: 'chat' });
    await session.send([{ type: 'text', text: 'What colour?' }]);
    expect(conversation(second.calls[0].messages).map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(conversation(second.calls[0].messages)[0]).toEqual({ role: 'user', content: parts });
    store.close?.();
  });

  it('session.stream(parts) records the parts as well', async () => {
    const store = makeStore();
    const session = createAgent({ provider: mockModel(['A cat.']), store }).session({ id: 'chat' });
    await session.stream(parts).result;

    expect((await store.sessions!.load('chat'))![0]).toEqual({ role: 'user', content: parts });
    store.close?.();
  });

  it('a checkpointed turn with parts survives a crash and resume()', async () => {
    const store = makeStore();
    let runs = 0;
    const flaky = defineTool({
      name: 'flaky',
      description: 'dies once',
      input: z.object({}),
      execute: async () => {
        if (++runs === 1) throw new PropagatingToolError('process died');
        return 'ok';
      },
    });
    const call = { toolCalls: [{ name: 'flaky', id: 'call_flaky' }] };
    await expect(
      createAgent({ provider: mockModel([call]), tools: [flaky], store }).session({ id: 'chat' }).send(parts)
    ).rejects.toThrow('process died');

    const resumed = await createAgent({ provider: mockModel(['Done.']), tools: [flaky], store }).resume('chat');

    expect(resumed?.text).toBe('Done.');
    expect((await store.sessions!.load('chat'))![0]).toEqual({ role: 'user', content: parts });
    store.close?.();
  });
});
