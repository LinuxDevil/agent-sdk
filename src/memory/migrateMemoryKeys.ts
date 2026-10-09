import { memoryKey, type MemoryScopeContext, type MemorySlot } from './defineMemory';

/** Options for {@link migrateMemoryKeys}. */
export interface MigrateMemoryKeysOptions {
  /**
   * The run contexts whose keys to migrate. Default `[{}]`, which covers a
   * `'global'` slot. For a `'session'` slot pass one `{ sessionId }` per
   * session; for a scope function, the contexts it keys on (e.g.
   * `{ metadata: { userId } }`). Contexts the slot gives no key are skipped.
   */
  contexts?: ReadonlyArray<MemoryScopeContext>;
  /**
   * Remove the items from the old key once copied. Default `false`: before
   * namespacing, slots with the same scope shared one key, so another slot may
   * still need to migrate the same items.
   */
  removeLegacy?: boolean;
}

/** What {@link migrateMemoryKeys} did. */
export interface MigrateMemoryKeysResult {
  /** Items copied, over all keys. */
  moved: number;
  /** Each old key that held items, the key they were copied to, and how many. */
  keys: Array<{
    /** The old key. */
    from: string;
    /** The key its items were copied to. */
    to: string;
    /** How many items were copied. */
    moved: number;
  }>;
}

/**
 * Eve MEM-F10: copies a slot's items from the provider key earlier alphas
 * used - the bare scope key (`global`, `session:s1`, `user:u-42`) - to the key
 * it uses now, `<slot name>#<scope key>` (see {@link memoryKey}). Items are
 * added oldest first, so the newest stays newest; `add()` dedupes on text, so
 * running it again copies nothing twice. Each copy gets a new `id` and
 * `createdAt`; `text` and `metadata` are kept.
 *
 * @example
 * ```ts
 * const notes = defineMemory({ name: 'notes', scope: 'global', provider });
 * await migrateMemoryKeys(notes); // once, after upgrading
 * await migrateMemoryKeys(prefs, { contexts: sessionIds.map((sessionId) => ({ sessionId })) });
 * ```
 */
export async function migrateMemoryKeys(slot: MemorySlot, { contexts = [{}], removeLegacy = false }: MigrateMemoryKeysOptions = {}): Promise<MigrateMemoryKeysResult> {
  const result: MigrateMemoryKeysResult = { moved: 0, keys: [] };
  const seen = new Set<string>();
  for (const ctx of contexts) {
    const to = memoryKey(slot, ctx);
    if (to === undefined || seen.has(to)) continue;
    seen.add(to);
    const from = to.slice(slot.name.length + 1);
    const items = await slot.provider.list(from);
    if (items.length === 0) continue;
    for (const item of items.slice().reverse()) {
      await slot.provider.add(to, { text: item.text, ...(item.metadata && { metadata: item.metadata }) });
      if (removeLegacy) await slot.provider.remove(from, item.id);
    }
    result.moved += items.length;
    result.keys.push({ from, to, moved: items.length });
  }
  return result;
}
