import type { MemoryItem, MemoryProvider } from '../../memory/defineMemory';
import { itemsProvider, type MemoryProviderOptions } from '../../memory/providers';
import type { SqliteStore } from './SqliteStore';
import { Statements } from './stores';

/**
 * Keeps memory in the agent's `SqliteStore` file (table `memory_items`, one
 * JSON array per scope key, as `fileMemory` writes), so sessions, checkpoints
 * and memory share one database. Each change is one write transaction, so
 * several providers (or processes) on one database keep every item. The
 * store must stay open while the provider is used; `store.prune()` leaves
 * memory alone.
 *
 * @example
 * ```ts
 * import { SqliteStore, sqliteMemory } from '@lousho/build-ai-agent/sqlite';
 *
 * const store = new SqliteStore('./.lousho/agent.db');
 * const prefs = defineMemory({ name: 'prefs', scope: 'global', provider: sqliteMemory(store) });
 * ```
 */
export function sqliteMemory(store: SqliteStore, options?: MemoryProviderOptions): MemoryProvider {
  const sql = new Statements(store.connection);
  const load = (key: string): MemoryItem[] => {
    const row = sql.get('SELECT payload FROM memory_items WHERE scope_key = ?').get(key);
    return row ? (JSON.parse(String(row.payload)) as MemoryItem[]) : [];
  };
  const save = (key: string, items: MemoryItem[]): void => {
    sql
      .get(
        `INSERT INTO memory_items (scope_key, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(items), Date.now());
  };
  return itemsProvider(
    {
      load: async (key) => load(key),
      save: async (key, items) => save(key, items),
      // Eve MEM-F8: read-change-write in one write transaction, so other
      // providers on this database (in this process or another) never
      // interleave with it and drop an item.
      update: (key, change) => store.connection.transactionAsync(() => save(key, change(load(key)))),
    },
    options
  );
}
