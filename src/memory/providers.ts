import { newId } from '../utils/id';
import { assertScopeKey, type MemoryItem, type MemoryProvider } from './defineMemory';
import { keyedQueue } from './keyedQueue';

/** Options of the built-in memory providers. */
export interface MemoryProviderOptions {
  /** Most items kept per scope key; adding one more drops the oldest. Default 1000. */
  maxItems?: number;
}

/** Loads and saves one scope key's items, oldest first. */
interface ItemStore {
  load(scopeKey: string): Promise<MemoryItem[]>;
  save(scopeKey: string, items: MemoryItem[]): Promise<void>;
  /**
   * Eve MEM-F8: loads, changes and saves one key's items as one step that
   * other writers of the same storage (other provider instances, other
   * processes) cannot interleave with. Without it, `itemsProvider` does
   * `load` then `save`, serialized only within this provider instance.
   */
  update?(scopeKey: string, change: (items: MemoryItem[]) => MemoryItem[]): Promise<void>;
}

/** Lower-cased words of `text`, a trailing plural `s` dropped (`cats` -> `cat`). */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/**
 * The newest `limit` items. With a non-blank `query`, only items sharing a
 * whole word with it (any case; its words of 3+ letters, or all its words
 * when it has none that long), the items matching more of its words first,
 * then newest first (Eve MEM-F1).
 */
function select(items: readonly MemoryItem[], { limit, query }: { limit?: number; query?: string } = {}): MemoryItem[] {
  const newest = items.slice().reverse();
  const all = [...new Set(wordsOf(query ?? ''))];
  if (!query?.trim()) return newest.slice(0, limit);
  const long = all.filter((w) => w.length >= 3);
  const words = long.length > 0 ? long : all;
  return newest
    .map((item) => {
      const have = new Set(wordsOf(item.text));
      return { item, hits: words.filter((w) => have.has(w)).length };
    })
    .filter(({ hits }) => hits > 0)
    .sort((a, b) => b.hits - a.hits) // stable: ties stay newest first
    .slice(0, limit)
    .map(({ item }) => item);
}

/**
 * A `MemoryProvider` over `store`. Changes to one key are made one at a time,
 * so concurrent adds keep every item - within this provider instance, or
 * across instances and processes when `store` has an atomic `update`. `add`
 * dedupes on `text`: adding an item whose text is already stored returns the
 * stored one unchanged. `upsert` replaces an item by id (Eve MEM-F2).
 */
export function itemsProvider(store: ItemStore, { maxItems = 1000 }: MemoryProviderOptions = {}): MemoryProvider {
  const serial = keyedQueue();
  const update = async (key: string, method: string, change: (items: MemoryItem[]) => MemoryItem[]): Promise<void> => {
    assertScopeKey(key, method);
    await serial(key, async () => (store.update ? store.update(key, change) : store.save(key, change(await store.load(key)))));
  };
  return {
    async list(key, options) {
      assertScopeKey(key, 'list');
      return select(await store.load(key), options);
    },
    async add(key, { text, metadata }) {
      let stored: MemoryItem | undefined;
      await update(key, 'add', (items) => {
        stored = items.find((item) => item.text === text);
        if (stored) return items;
        stored = { id: newId(), text, createdAt: new Date().toISOString(), ...(metadata && { metadata }) };
        return [...items, stored].slice(-maxItems);
      });
      return stored!;
    },
    async upsert(key, { id, text, metadata }) {
      let stored: MemoryItem | undefined;
      await update(key, 'upsert', (items) => {
        const old = id === undefined ? undefined : items.find((item) => item.id === id);
        if (!old) {
          stored = items.find((item) => item.text === text);
          if (stored) return items;
        }
        stored = { id: old?.id ?? newId(), text, createdAt: new Date().toISOString(), ...(metadata && { metadata }) };
        return [...items.filter((item) => item.id !== stored!.id && item.text !== text), stored].slice(-maxItems);
      });
      return stored!;
    },
    remove: (key, id) => update(key, 'remove', (items) => items.filter((item) => item.id !== id)),
  };
}

/**
 * Keeps memory in this process (lost on restart). For tests and demos.
 *
 * @example
 * ```ts
 * const notes = defineMemory({ name: 'notes', scope: 'global', provider: inMemoryMemory() });
 * ```
 */
export function inMemoryMemory(options?: MemoryProviderOptions): MemoryProvider {
  const byKey = new Map<string, MemoryItem[]>();
  return itemsProvider(
    {
      load: async (key) => byKey.get(key) ?? [],
      save: async (key, items) => void byKey.set(key, items),
    },
    options
  );
}
