import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { mockModel, type MockRequest } from '../testing';
import { defineMemory, inMemoryMemory, type MemoryItem, type MemoryProvider } from './index';

const systemOf = (call: MockRequest | undefined): string => String(call?.messages.find((m) => m.role === 'system')?.content ?? '');
const toolsOf = (call: MockRequest | undefined): string[] => (call?.tools ?? []).map((t) => t.function.name);
const lastToolResult = (call: MockRequest): unknown => JSON.parse(String(call.messages.at(-1)?.content));

describe('memory that can be corrected (Eve MEM-F2)', () => {
  it('expose: { forget: true } adds forget_<name>, shows ids in the recalled block, and forgotten items are not recalled again', async () => {
    const provider = inMemoryMemory();
    const french = await provider.add('prefs#global', { text: 'The user wants answers in French.' });
    const prefs = defineMemory({ name: 'prefs', scope: 'global', provider, expose: { forget: true } });

    const model = mockModel([
      { toolCalls: [{ name: 'forget_prefs', args: { id: french.id } }] },
      { toolCalls: [{ name: 'remember_prefs', args: { text: 'The user now wants answers in English only.' } }] },
      { toolCalls: [{ name: 'forget_prefs', args: { id: 'no-such-id' } }] },
      'ok',
    ]);
    const agent = createAgent({ provider: model, memory: [prefs] });
    await agent.send('Answer in English from now on.');

    expect(toolsOf(model.calls[0])).toEqual(['remember_prefs', 'recall_prefs', 'forget_prefs']);
    expect(systemOf(model.calls[0])).toContain(`- The user wants answers in French. (id: ${french.id})`);
    expect(lastToolResult(model.calls[1])).toEqual({ forgotten: french.id });
    expect(lastToolResult(model.calls[3])).toEqual({ forgotten: null, reason: 'No item with this id.' });

    const next = mockModel(['ok']);
    await createAgent({ provider: next, memory: [prefs] }).send('hi');
    expect(systemOf(next.lastCall)).toContain('The user now wants answers in English only.');
    expect(systemOf(next.lastCall)).not.toContain('French');
  });

  it('forget is off by default', async () => {
    const model = mockModel(['ok']);
    await createAgent({ provider: model, memory: [defineMemory({ name: 'notes', scope: 'global', provider: inMemoryMemory() })] }).send('hi');
    expect(toolsOf(model.lastCall)).toEqual(['remember_notes', 'recall_notes']);
  });

  it('an itemSchema slot with itemKey upserts: remembering the same key replaces the stored item', async () => {
    const provider = inMemoryMemory();
    const state = defineMemory({
      name: 'state',
      scope: 'global',
      provider,
      itemSchema: z.object({ topic: z.string(), value: z.string() }),
      itemKey: 'topic',
    });
    const model = mockModel([
      { toolCalls: [{ name: 'remember_state', args: { topic: 'language', value: 'French' } }] },
      { toolCalls: [{ name: 'remember_state', args: { topic: 'tone', value: 'casual' } }] },
      { toolCalls: [{ name: 'remember_state', args: { topic: 'language', value: 'English' } }] },
      'done',
    ]);
    await createAgent({ provider: model, memory: [state] }).send('hi');

    const items = await provider.list('state#global');
    expect(items.map((item) => item.metadata)).toEqual([
      { topic: 'language', value: 'English' },
      { topic: 'tone', value: 'casual' },
    ]);
    const first = lastToolResult(model.calls[1]) as { remembered: string };
    expect(lastToolResult(model.calls[3])).toEqual({ remembered: first.remembered, replaced: true });
    expect(items[0].id).toBe(first.remembered);

    expect(() => defineMemory({ name: 's', scope: 'global', provider, itemKey: 'topic' })).toThrow(/itemKey needs an itemSchema/);
    expect(() => defineMemory({ name: 's', scope: 'global', provider, itemSchema: z.object({}), itemKey: [] })).toThrow(/itemKey/);
  });

  it('a provider without upsert still replaces (remove, then add)', async () => {
    const inner = inMemoryMemory();
    const provider: MemoryProvider = { list: inner.list, add: inner.add, remove: inner.remove };
    const state = defineMemory({ name: 'state', scope: 'global', provider, itemSchema: z.object({ k: z.string(), v: z.number() }), itemKey: ['k'] });
    const model = mockModel([
      { toolCalls: [{ name: 'remember_state', args: { k: 'trust', v: 10 } }] },
      { toolCalls: [{ name: 'remember_state', args: { k: 'trust', v: 8 } }] },
      'done',
    ]);
    await createAgent({ provider: model, memory: [state] }).send('hi');
    expect((await provider.list('state#global')).map((item: MemoryItem) => item.metadata)).toEqual([{ k: 'trust', v: 8 }]);
  });
});
