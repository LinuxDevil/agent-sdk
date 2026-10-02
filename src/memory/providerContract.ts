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
