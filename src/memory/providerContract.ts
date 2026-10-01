import { describe, it, expect } from 'vitest';
import type { MemoryProvider } from './defineMemory';
import type { MemoryProviderOptions } from './providers';

/** Contract every `MemoryProvider` built on `itemsProvider` satisfies; run it against each provider. */
export function describeMemoryProviderContract(
  name: string,
  make: (options?: MemoryProviderOptions) => MemoryProvider | Promise<MemoryProvider>
): void {
  describe(`${name} provider contract`, () => {
    it('keeps every concurrent add, newest first, bounded by maxItems', async () => {
      const provider = await make({ maxItems: 3 });
      await Promise.all(['one', 'two', 'three', 'four'].map((text) => provider.add('k', { text })));
      expect((await provider.list('k')).map((i) => i.text)).toEqual(['four', 'three', 'two']);
    });

    it('filters by query, limits and removes', async () => {
      const provider = await make();
      for (const text of ['one', 'two', 'three']) await provider.add('k', { text });
      expect((await provider.list('k', { query: 'THREE?' })).map((i) => i.text)).toEqual(['three']);
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
