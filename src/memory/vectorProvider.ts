/**
 * Semantic memory: a `MemoryProvider` that ranks items by the cosine
 * similarity of their embedding to the query's. Scoring is brute force in
 * JavaScript over one scope key's items (fine up to `maxItems`), and only
 * items of the requested scope key and of the same embedder are ever scored.
 * No `node:*` imports, so it runs in a Worker.
 */
import { SDKError } from '../execution/errors';
import { newId } from '../utils/id';
import { assertScopeKey, type MemoryItem, type MemoryProvider } from './defineMemory';
import type { EmbeddingProvider } from './embeddings';
import { keyedQueue } from './keyedQueue';

/** Options of the vector memory providers. */
export interface VectorMemoryOptions {
  embedder: EmbeddingProvider;
  /** Most items kept per scope key; adding one more drops the oldest. Default 5000. */
  maxItems?: number;
  /** Lowest cosine similarity a query result may have. Default 0.2. */
  minScore?: number;
}

/** A vector memory provider, with `reindex()`. */
export type VectorMemoryProvider = MemoryProvider & {
  /** Re-embeds the items of `scopeKey` (all keys when omitted) that another embedder embedded; returns how many changed. */
  reindex(scopeKey?: string): Promise<number>;
};

/** One stored item with its unit-length vector. */
export interface VectorRow {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  /** Id of the embedder that made `vector`. */
  embedder: string;
  vector: Float32Array;
}

/** Where a vector provider keeps rows. Rows of one key are listed oldest first. */
export interface VectorItemStore {
  load(scopeKey: string): Promise<VectorRow[]>;
  /** Adds the row, or replaces the row with the same id in place (`reindex()` does that). */
  insert(scopeKey: string, row: VectorRow): Promise<void>;
  remove(scopeKey: string, id: string): Promise<void>;
  /** Keeps the newest `maxItems` rows of the key. */
  trim(scopeKey: string, maxItems: number): Promise<void>;
  scopeKeys(): Promise<string[]>;
}

const REINDEX_BATCH = 96;

/** Scales `vector` to unit length (a zero vector stays zero), so cosine similarity is a dot product. */
function normalize(vector: readonly number[]): Float32Array {
  let sum = 0;
  for (const x of vector) sum += x * x;
  const length = Math.sqrt(sum);
  const out = new Float32Array(vector.length);
  if (length > 0) for (let i = 0; i < vector.length; i++) out[i] = vector[i] / length;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function toItem({ id, text, createdAt, metadata }: VectorRow, score?: number): MemoryItem {
  const merged = score === undefined ? metadata : { ...metadata, score };
  return { id, text, createdAt, ...(merged && { metadata: merged }) };
}

async function embedAll(embedder: EmbeddingProvider, texts: readonly string[]): Promise<Float32Array[]> {
  const vectors = await embedder.embed(texts);
  if (vectors.length !== texts.length) {
    throw new SDKError(`Embedder '${embedder.id}' returned ${vectors.length} vectors for ${texts.length} texts.`, 'LOUSHO_PROVIDER_REQUEST_FAILED');
  }
  return vectors.map(normalize);
}

/** A {@link VectorMemoryProvider} over `store`. Changes to one key are made one at a time. */
export function vectorMemory(store: VectorItemStore, options: VectorMemoryOptions): VectorMemoryProvider {
  const { embedder, maxItems = 5000, minScore = 0.2 } = options;
  if (typeof embedder?.embed !== 'function' || typeof embedder.id !== 'string') {
    throw new SDKError('Vector memory needs an embedder, e.g. aiSdkEmbedder(openai.embedding(...)).', 'LOUSHO_MEMORY_INVALID');
  }
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new SDKError(`Vector memory: maxItems must be a positive integer, got ${maxItems}.`, 'LOUSHO_MEMORY_INVALID');
  }
  const serial = keyedQueue();

  async function reindexKey(key: string): Promise<number> {
    const stale = (await store.load(key)).filter((row) => row.embedder !== embedder.id);
    for (let start = 0; start < stale.length; start += REINDEX_BATCH) {
      const batch = stale.slice(start, start + REINDEX_BATCH);
      const vectors = await embedAll(
        embedder,
        batch.map((row) => row.text)
      );
      for (const [i, row] of batch.entries()) await store.insert(key, { ...row, embedder: embedder.id, vector: vectors[i] });
    }
    return stale.length;
  }

  return {
    ranking: 'relevance',
    async list(key, { limit, query } = {}) {
      assertScopeKey(key, 'list');
      const text = query?.trim();
      if (!text) return (await store.load(key)).reverse().slice(0, limit).map((row) => toItem(row));
      const [target] = await embedAll(embedder, [text]);
      const scored = (await store.load(key)).flatMap((row, order) => {
        if (row.embedder !== embedder.id || row.vector.length !== target.length) return [];
        const score = dot(row.vector, target);
        return score >= minScore ? [{ row, score, order }] : [];
      });
      scored.sort((a, b) => b.score - a.score || b.order - a.order);
      return scored.slice(0, limit).map(({ row, score }) => toItem(row, score));
    },
    add: async (key, { text, metadata }) => {
      assertScopeKey(key, 'add');
      return serial(key, async () => {
        // Dedupe on text, like itemsProvider: a stored duplicate is returned
        // unchanged (and no embedding call is spent on it).
        const existing = (await store.load(key)).find((row) => row.text === text);
        if (existing) return toItem(existing);
        const [vector] = await embedAll(embedder, [text]);
        const row: VectorRow = { id: newId(), text, createdAt: new Date().toISOString(), embedder: embedder.id, vector, ...(metadata && { metadata }) };
        await store.insert(key, row);
        await store.trim(key, maxItems);
        return toItem(row);
      });
    },
    remove: async (key, id) => {
      assertScopeKey(key, 'remove');
      await serial(key, () => store.remove(key, id));
    },
    async reindex(scopeKey) {
      const keys = scopeKey === undefined ? await store.scopeKeys() : [scopeKey];
      let changed = 0;
      for (const key of keys) changed += await serial(key, () => reindexKey(key));
      return changed;
    },
  };
}

/** Internal: rows kept in this process, shareable by several providers (tests use two embedders over one store). */
export function memoryVectorStore(): VectorItemStore {
  const byKey = new Map<string, VectorRow[]>();
  return {
    load: async (key) => [...(byKey.get(key) ?? [])],
    async insert(key, row) {
      const rows = byKey.get(key) ?? [];
      const at = rows.findIndex((r) => r.id === row.id);
      if (at >= 0) rows[at] = row;
      else rows.push(row);
      byKey.set(key, rows);
    },
    async remove(key, id) {
      byKey.set(
        key,
        (byKey.get(key) ?? []).filter((row) => row.id !== id)
      );
    },
    async trim(key, maxItems) {
      const rows = byKey.get(key);
      if (rows && rows.length > maxItems) byKey.set(key, rows.slice(-maxItems));
    },
    scopeKeys: async () => [...byKey.keys()],
  };
}

/**
 * Semantic memory kept in this process (lost on restart): `list()` with a
 * query ranks by meaning, most similar first, each result with its cosine
 * similarity in `metadata.score`. Without a query it lists the newest first.
 *
 * @example
 * ```ts
 * const memory = inMemoryVectorMemory({ embedder: aiSdkEmbedder(openai.embedding('text-embedding-3-small')) });
 * ```
 */
export function inMemoryVectorMemory(options: VectorMemoryOptions): VectorMemoryProvider {
  return vectorMemory(memoryVectorStore(), options);
}
