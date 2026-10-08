/** N15: inMemoryVectorMemory, hashEmbedder, and recall by meaning in an agent run. */
import { describe, expect, it } from 'vitest';
import { createAgent } from '../createAgent';
import { hashEmbedder, mockModel } from '../testing';
import { defineMemory, memoryKey } from './defineMemory';
import type { EmbeddingProvider } from './embeddings';
import { describeMemoryProviderContract } from './providerContract';
import { inMemoryMemory } from './providers';
import { inMemoryVectorMemory, memoryVectorStore, vectorMemory } from './vectorProvider';

const embedder = hashEmbedder();
const texts = async (list: Promise<{ text: string }[]>) => (await list).map((i) => i.text);

describeMemoryProviderContract('inMemoryVectorMemory', (options) => inMemoryVectorMemory({ embedder, ...options }), { query: 'rank' });

describe('hashEmbedder', () => {
  it('is deterministic, unit length and has the id of its size', async () => {
    const [a, b] = await embedder.embed(['Sam is vegetarian', 'Sam is vegetarian']);
    expect(a).toEqual(b);
    expect(a).toHaveLength(256);
    expect(Math.hypot(...a)).toBeCloseTo(1);
    expect(embedder.id).toBe('hash:256');
    expect(hashEmbedder({ dimensions: 32 }).id).toBe('hash:32');
    expect(() => hashEmbedder({ dimensions: 0 })).toThrow(RangeError);
  });

  it('puts texts that share words closer than texts that do not', async () => {
    const [food, vegetarian, weather] = await embedder.embed(['vegetarian food', 'vegetarian', 'rain tomorrow']);
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
    expect(dot(food, vegetarian)).toBeGreaterThan(0.6);
    expect(dot(food, weather)).toBeLessThan(0.2);
  });
});

describe('inMemoryVectorMemory', () => {
  const facts = ['Sam is vegetarian', 'The office is in Oslo', 'Prefers dark mode'];
  async function filled(options: { minScore?: number; maxItems?: number } = {}) {
    const memory = inMemoryVectorMemory({ embedder, ...options });
    for (const text of facts) await memory.add('k', { text });
    return memory;
  }

  it('ranks the related item first and reports the score in metadata', async () => {
    const memory = await filled({ minScore: 0 });
    const found = await memory.list('k', { query: 'vegetarian food' });
    expect(found[0].text).toBe('Sam is vegetarian');
    expect(found[0].metadata?.score).toBeGreaterThan(found[1].metadata?.score as number);
    expect(found).toHaveLength(3);
    expect(await texts(memory.list('k', { query: 'vegetarian food', limit: 1 }))).toEqual(['Sam is vegetarian']);
  });

  it('keeps stored metadata next to the score, and the stored item without a score', async () => {
    const memory = inMemoryVectorMemory({ embedder });
    const added = await memory.add('k', { text: 'Sam is vegetarian', metadata: { source: 'chat' } });
    expect(added.metadata).toEqual({ source: 'chat' });
    expect((await memory.list('k', { query: 'vegetarian' }))[0].metadata).toEqual({ source: 'chat', score: expect.any(Number) });
    expect((await memory.list('k'))[0].metadata).toEqual({ source: 'chat' });
  });

  it('drops items under minScore', async () => {
    expect(await texts((await filled()).list('k', { query: 'vegetarian food' }))).toEqual(['Sam is vegetarian']);
    expect(await texts((await filled()).list('k', { query: 'quantum chromodynamics' }))).toEqual([]);
  });

  it('breaks ties by newest first', async () => {
    const memory = inMemoryVectorMemory({ embedder });
    // Same bag of words, different text (identical text would dedupe on add):
    // both rows score the same, so the newer one ranks first.
    await memory.add('k', { text: 'green tea' });
    await memory.add('k', { text: 'tea green' });
    const [newer, older] = await memory.list('k', { query: 'tea' });
    expect(newer.id).not.toBe(older.id);
    expect((await memory.list('k')).map((i) => i.id)).toEqual([newer.id, older.id]);
  });

  it('lists newest first without a query or with a blank one', async () => {
    const memory = await filled();
    expect(await texts(memory.list('k'))).toEqual([...facts].reverse());
    expect(await texts(memory.list('k', { query: '   ' }))).toEqual([...facts].reverse());
  });

  it('drops the oldest beyond maxItems', async () => {
    const memory = await filled({ maxItems: 2 });
    expect(await texts(memory.list('k'))).toEqual(['Prefers dark mode', 'The office is in Oslo']);
  });

  it('never scores another scope key, even for identical text', async () => {
    const memory = inMemoryVectorMemory({ embedder });
    await memory.add('user:a', { text: 'Sam is vegetarian' });
    expect(await memory.list('user:b', { query: 'Sam is vegetarian' })).toEqual([]);
  });

  it('skips items of another embedder when ranking, lists them, and fixes them with reindex()', async () => {
    const store = memoryVectorStore();
    const before = vectorMemory(store, { embedder: { id: 'old', embed: async (list) => list.map(() => [1, 0, 0]) } });
    await before.add('k', { text: 'Sam is vegetarian' });
    const after = vectorMemory(store, { embedder });
    await after.add('k', { text: 'Prefers dark mode' });
    await after.add('other', { text: 'Sam is vegetarian' });

    expect(await texts(after.list('k', { query: 'vegetarian' }))).toEqual([]);
    expect(await texts(after.list('k'))).toEqual(['Prefers dark mode', 'Sam is vegetarian']);

    expect(await after.reindex('k')).toBe(1);
    expect(await texts(after.list('k', { query: 'vegetarian' }))).toEqual(['Sam is vegetarian']);
    expect(await after.reindex()).toBe(0);
    expect(await texts(after.list('k'))).toEqual(['Prefers dark mode', 'Sam is vegetarian']);
  });

  it('reindexes every scope key when none is named', async () => {
    const store = memoryVectorStore();
    const old = vectorMemory(store, { embedder: { id: 'old', embed: async (list) => list.map(() => [1]) } });
    await old.add('a', { text: 'one' });
    await old.add('b', { text: 'two' });
    expect(await vectorMemory(store, { embedder }).reindex()).toBe(2);
  });

  it('does not bring back an item removed while it was reindexing', async () => {
    const store = memoryVectorStore();
    const old = vectorMemory(store, { embedder: { id: 'old', embed: async (list) => list.map(() => [1]) } });
    const { id } = await old.add('k', { text: 'Sam is vegetarian' });
    const slow: EmbeddingProvider = { id: 'slow', embed: async (list) => (await new Promise((r) => setTimeout(r, 20)), list.map(() => [1])) };
    const fresh = vectorMemory(store, { embedder: slow });
    const reindexing = fresh.reindex('k');
    const removing = fresh.remove('k', id);
    await Promise.all([reindexing, removing]);
    expect(await fresh.list('k')).toEqual([]);
  });

  it('adds nothing when embedding fails, and fails clearly on a short answer', async () => {
    const failing: EmbeddingProvider = { id: 'down', embed: async () => Promise.reject(new Error('quota')) };
    const memory = inMemoryVectorMemory({ embedder: failing });
    await expect(memory.add('k', { text: 'x' })).rejects.toThrow('quota');
    await expect(memory.add('k', { text: 'y' })).rejects.toThrow('quota');
    expect(await memory.list('k')).toEqual([]);
    const short = inMemoryVectorMemory({ embedder: { id: 'short', embed: async () => [] } });
    await expect(short.add('k', { text: 'x' })).rejects.toThrow(/returned 0 vectors for 1 texts/);
  });

  it('rejects a missing embedder and a bad maxItems', () => {
    expect(() => inMemoryVectorMemory({} as never)).toThrow(/needs an embedder/);
    expect(() => inMemoryVectorMemory({ embedder, maxItems: 0 })).toThrow(/maxItems/);
  });
});

describe('semantic recall in a run', () => {
  it('puts the most relevant item first in the memory block and says so in the recall tool', async () => {
    const provider = inMemoryVectorMemory({ embedder, minScore: 0 });
    const notes = defineMemory({ name: 'notes', scope: 'global', provider, recall: { query: 'last-input', maxItems: 3 } });
    for (const text of ['The office is in Oslo', 'Sam is vegetarian food lover', 'Prefers dark mode'])
      await provider.add(memoryKey(notes)!, { text });
    const model = mockModel(['ok']);
    await createAgent({ provider: model, memory: [notes] }).send('vegetarian food');
    const system = String(model.lastCall?.messages.find((m) => m.role === 'system')?.content);
    expect(system).toContain('<memory name="notes">\n- Sam is vegetarian food lover\n');
    expect(model.lastCall?.tools?.map((t) => t.function.name)).toContain('recall_notes');
    expect(model.lastCall?.tools?.find((t) => t.function.name === 'recall_notes')?.function.description).toContain('by meaning, most relevant first');
  });

  it('keeps the newest-first wording for other providers', async () => {
    const notes = defineMemory({ name: 'notes', scope: 'global', provider: inMemoryMemory() });
    const model = mockModel(['ok']);
    await createAgent({ provider: model, memory: [notes] }).send('hi');
    expect(model.lastCall?.tools?.find((t) => t.function.name === 'recall_notes')?.function.description).toContain('memory, newest items first.');
  });
});
