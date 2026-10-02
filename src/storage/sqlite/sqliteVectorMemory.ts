import { vectorMemory, type VectorItemStore, type VectorMemoryOptions, type VectorMemoryProvider, type VectorRow } from '../../memory/vectorProvider';
import type { SqliteStore } from './SqliteStore';
import { Statements } from './stores';

/** Little-endian float32 bytes of `vector` (every supported platform is little-endian). */
function encode(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength).slice();
}

/** A `Float32Array` over a 4-byte-aligned copy of `bytes` (`node:sqlite` hands out views that may not be aligned). */
function decode(bytes: unknown, dimensions: number): Float32Array {
  const copy = new Uint8Array(bytes as ArrayLike<number>).slice();
  return new Float32Array(copy.buffer, 0, Math.min(dimensions, Math.floor(copy.byteLength / 4)));
}

/**
 * Semantic memory in the agent's `SqliteStore` file (table `memory_vectors`,
 * one row per item with its embedding as float32 bytes), next to sessions,
 * checkpoints and `sqliteMemory()`. `list()` with a query embeds it and ranks
 * the scope key's items by cosine similarity in JavaScript, so keep
 * `maxItems` (default 5000 per scope key) in mind. The store must stay open
 * while the provider is used; `store.prune()` leaves memory alone.
 *
 * @example
 * ```ts
 * import { SqliteStore, sqliteVectorMemory } from '@lousho/build-ai-agent/sqlite';
 *
 * const store = new SqliteStore('./.lousho/agent.db');
 * const facts = sqliteVectorMemory(store, { embedder: aiSdkEmbedder(openai.embedding('text-embedding-3-small')) });
 * ```
 */
export function sqliteVectorMemory(store: SqliteStore, options: VectorMemoryOptions): VectorMemoryProvider {
  const sql = new Statements(store.connection);
  const rows: VectorItemStore = {
    async load(key) {
      return sql
        .get(
          `SELECT id, text, metadata, created_at, embedder, dimensions, embedding FROM memory_vectors
           WHERE scope_key = ? ORDER BY created_at, rowid`
        )
        .all(key)
        .map(
          (row): VectorRow => ({
            id: String(row.id),
            text: String(row.text),
            createdAt: String(row.created_at),
            embedder: String(row.embedder),
            vector: decode(row.embedding, Number(row.dimensions)),
            ...(typeof row.metadata === 'string' && { metadata: JSON.parse(row.metadata) as Record<string, unknown> }),
          })
        );
    },
    async insert(key, row) {
      sql
        .get(
          `INSERT INTO memory_vectors (scope_key, id, text, metadata, created_at, embedder, dimensions, embedding)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope_key, id) DO UPDATE SET
             text = excluded.text, metadata = excluded.metadata, embedder = excluded.embedder,
             dimensions = excluded.dimensions, embedding = excluded.embedding`
        )
        .run(key, row.id, row.text, row.metadata ? JSON.stringify(row.metadata) : null, row.createdAt, row.embedder, row.vector.length, encode(row.vector));
    },
    async remove(key, id) {
      sql.get('DELETE FROM memory_vectors WHERE scope_key = ? AND id = ?').run(key, id);
    },
    async trim(key, maxItems) {
      sql
        .get(
          `DELETE FROM memory_vectors WHERE scope_key = ? AND rowid NOT IN (
             SELECT rowid FROM memory_vectors WHERE scope_key = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`
        )
        .run(key, key, maxItems);
    },
    async scopeKeys() {
      return sql
        .get('SELECT DISTINCT scope_key FROM memory_vectors')
        .all()
        .map((row) => String(row.scope_key));
    },
  };
  return vectorMemory(rows, options);
}
