import { newId } from '../utils/id';
import type { MemoryItem, MemoryProvider } from './defineMemory';

/** Options of the built-in memory providers. */
export interface MemoryProviderOptions {
  /** Most items kept per scope key; adding one more drops the oldest. Default 1000. */
  maxItems?: number;
}

/** Loads and saves one scope key's items, oldest first. */
interface ItemStore {
  load(scopeKey: string): Promise<MemoryItem[]>;
  save(scopeKey: string, items: MemoryItem[]): Promise<void>;
}

/** The newest `limit` items; with a `query`, only those containing one of its words (3+ letters, any case). */
function select(items: readonly MemoryItem[], { limit, query }: { limit?: number; query?: string } = {}): MemoryItem[] {
  const words = (query ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  const matching = words.length === 0 ? items : items.filter((i) => words.some((w) => i.text.toLowerCase().includes(w)));
  return matching.slice().reverse().slice(0, limit);
}

/** A `MemoryProvider` over `store`. Changes to one key are made one at a time, so concurrent adds keep every item. */
export function itemsProvider(store: ItemStore, { maxItems = 1000 }: MemoryProviderOptions = {}): MemoryProvider {
  const queues = new Map<string, Promise<void>>();
  const update = (key: string, change: (items: MemoryItem[]) => MemoryItem[]): Promise<void> => {
    const done = (queues.get(key) ?? Promise.resolve()).then(async () => store.save(key, change(await store.load(key))));
    const tail = done.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => queues.get(key) === tail && queues.delete(key));
    return done;
  };
  return {
    list: async (key, options) => select(await store.load(key), options),
    async add(key, { text, metadata }) {
      const item: MemoryItem = { id: newId(), text, createdAt: new Date().toISOString(), ...(metadata && { metadata }) };
      await update(key, (items) => [...items, item].slice(-maxItems));
      return item;
    },
    remove: (key, id) => update(key, (items) => items.filter((item) => item.id !== id)),
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
