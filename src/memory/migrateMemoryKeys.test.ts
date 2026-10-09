import { describe, expect, it } from 'vitest';
import { defineMemory, inMemoryMemory, memoryKey, migrateMemoryKeys } from './index';

describe('migrateMemoryKeys (Eve MEM-F10)', () => {
  it("copies items stored under a slot's pre-namespacing key to its current key, oldest first", async () => {
    const provider = inMemoryMemory();
    await provider.add('global', { text: 'Lives in Oslo.' });
    await provider.add('global', { text: 'Likes tea.', metadata: { source: 'chat' } });
    const notes = defineMemory({ name: 'notes', scope: 'global', provider });
    expect(await provider.list(memoryKey(notes)!)).toEqual([]);

    expect(await migrateMemoryKeys(notes)).toEqual({ moved: 2, keys: [{ from: 'global', to: 'notes#global', moved: 2 }] });
    const items = await provider.list('notes#global');
    expect(items.map((item) => item.text)).toEqual(['Likes tea.', 'Lives in Oslo.']);
    expect(items[0].metadata).toEqual({ source: 'chat' });
    // The legacy items are kept by default (another slot may share the bare key).
    expect(await provider.list('global')).toHaveLength(2);
    // Running it again adds nothing: add() dedupes on text.
    await migrateMemoryKeys(notes);
    expect(await provider.list('notes#global')).toHaveLength(2);
  });

  it('migrates session and function scopes for the contexts given, and can remove the legacy items', async () => {
    const provider = inMemoryMemory();
    await provider.add('session:s1', { text: 'a' });
    await provider.add('user:u1', { text: 'b' });
    const prefs = defineMemory({ name: 'prefs', scope: 'session', provider });
    const facts = defineMemory({ name: 'facts', scope: (ctx) => (ctx.metadata?.userId ? `user:${String(ctx.metadata.userId)}` : undefined), provider });

    expect(await migrateMemoryKeys(prefs)).toEqual({ moved: 0, keys: [] });
    expect((await migrateMemoryKeys(prefs, { contexts: [{ sessionId: 's1' }, { sessionId: 's2' }], removeLegacy: true })).moved).toBe(1);
    expect((await provider.list('prefs#session:s1')).map((item) => item.text)).toEqual(['a']);
    expect(await provider.list('session:s1')).toEqual([]);

    const result = await migrateMemoryKeys(facts, { contexts: [{ metadata: { userId: 'u1' } }, { metadata: {} }] });
    expect(result).toEqual({ moved: 1, keys: [{ from: 'user:u1', to: 'facts#user:u1', moved: 1 }] });
  });
});
