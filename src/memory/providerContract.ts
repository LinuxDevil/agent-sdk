import { describe, it, expect } from 'vitest';
import type { MemoryProvider } from './defineMemory';
import type { MemoryProviderOptions } from './providers';

/**
 * Contract every `MemoryProvider` satisfies; run it against each provider.
 * `query: 'rank'` is for providers that rank by meaning: the matching item comes first, others may follow.
 */
export function describeMemoryProviderContract(
  name: string,
  make: (options?: MemoryProviderOptions) => MemoryProvider | Promise<MemoryProvider>,
  { query = 'filter' }: { query?: 'filter' | 'rank' } = {}
): void {
  describe(`${name} provider contract`, () => {
    it('keeps every concurrent add, newest first, bounded by maxItems', async () => {
      const provider = await make({ maxItems: 3 });
      await Promise.all(['one', 'two', 'three', 'four'].map((text) => provider.add('k', { text })));
      expect((await provider.list('k')).map((i) => i.text)).toEqual(['four', 'three', 'two']);
    });

    it(query === 'rank' ? 'ranks by query, limits and removes' : 'filters by query, limits and removes', async () => {
      const provider = await make();
      for (const text of ['one', 'two', 'three']) await provider.add('k', { text });
      const found = (await provider.list('k', { query: 'THREE?' })).map((i) => i.text);
      // A filter returns only the match; a ranking returns the match first.
      if (query === 'rank') expect(found[0]).toBe('three');
      else expect(found).toEqual(['three']);
      const [newest] = await provider.list('k', { limit: 1 });
      expect(newest.text).toBe('three');
      await provider.remove('k', newest.id);
      await provider.remove('k', 'no-such-id');
      expect((await provider.list('k')).map((i) => i.text)).toEqual(['two', 'one']);
    });

    if (query === 'filter') {
      it('matches whole words, never fails open, and ranks by hits (Eve MEM-F1)', async () => {
        const provider = await make();
        for (const text of ['works in education', 'a user from Oslo', 'the user likes green tea', 'AI researcher', 'has two cats']) {
          await provider.add('k', { text });
        }
        const texts = async (q: string) => (await provider.list('k', { query: q })).map((i) => i.text);
        // Short-word queries no longer return every item.
        expect(await texts('AI')).toEqual(['AI researcher']);
        expect(await texts('my id')).toEqual([]);
        expect(await texts('?!')).toEqual([]);
        // No substring false positives; a plural still matches.
        expect(await texts('cat')).toEqual(['has two cats']);
        // The item matching more query words comes first.
        expect(await texts('user tea preference')).toEqual(['the user likes green tea', 'a user from Oslo']);
        // A blank query is no query: newest first.
        expect(await texts('   ')).toHaveLength(5);
      });
    }

    it('keeps scope keys that differ only in case apart (Eve MEM-F3)', async () => {
      const provider = await make();
      await provider.add('notes#user:Alice', { text: 'alice secret' });
      await provider.add('notes#user:ALICE', { text: 'other user' });
      expect((await provider.list('notes#user:Alice')).map((i) => i.text)).toEqual(['alice secret']);
      expect((await provider.list('notes#user:ALICE')).map((i) => i.text)).toEqual(['other user']);
      expect(await provider.list('notes#user:alice')).toEqual([]);
    });

    it('dedupes on identical text, returning the stored item', async () => {
      const provider = await make();
      const first = await provider.add('k', { text: 'likes tea' });
      const again = await provider.add('k', { text: 'likes tea' });
      await provider.add('other', { text: 'likes tea' }); // dedupe is per scope key
      expect(again).toEqual(first);
      expect(await provider.list('k')).toEqual([first]);
    });

    it('round-trips metadata and keeps scope keys apart', async () => {
      const provider = await make();
      expect(await provider.list('session:a')).toEqual([]);
      const added = await provider.add('session:a', { text: 'héllo "q" \n', metadata: { source: 'test', n: [1, null] } });
      await provider.add('global', { text: 'shared' });
      expect(await provider.list('session:a')).toEqual([added]);
      expect(added.metadata).toEqual({ source: 'test', n: [1, null] });
      expect((await provider.list('global')).map((i) => i.text)).toEqual(['shared']);
    });
  });
}
