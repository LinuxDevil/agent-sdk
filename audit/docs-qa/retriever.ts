/**
 * Two retrieval backends over the same chunks and the same embedding model:
 *
 * - `sdk`:   the SDK's own semantic-memory primitive, `inMemoryVectorMemory()`
 *            (the only vector/retrieval API the SDK ships), one scope key 'docs'.
 * - `plain`: a 40-line in-memory cosine store with batched embedding and
 *            nomic's asymmetric `search_document:` / `search_query:` prefixes,
 *            which the SDK's `EmbeddingProvider` cannot express.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inMemoryVectorMemory } from '@lousho/build-ai-agent';
import { loadCorpus, type Chunk } from './corpus.js';
import { cachedEmbedder, nomicEmbedder, type CachedEmbedder } from './embedder.js';

export interface Hit {
  file: string;
  heading: string;
  section: string;
  score: number;
  text: string;
}

export interface Retriever {
  kind: 'sdk' | 'plain';
  chunks: Chunk[];
  embedder: CachedEmbedder;
  search(query: string, k?: number): Promise<Hit[]>;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CACHE_FILE = path.join(HERE, '.cache', 'embeddings.json');

export interface RetrieverOptions {
  kind?: 'sdk' | 'plain';
  /** Never call the embedding endpoint; every text must be cached (CI replay). */
  offline?: boolean;
}

const DOC = 'search_document: ';
const QUERY = 'search_query: ';

function embedText(c: Chunk): string {
  return `${c.heading}\n\n${c.text}`;
}

function norm(v: readonly number[]): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const l = Math.sqrt(s) || 1;
  return Float32Array.from(v, (x) => x / l);
}

export async function buildRetriever(opts: RetrieverOptions = {}): Promise<Retriever> {
  const kind = opts.kind ?? ((process.env.DOCSQA_RETRIEVER as 'sdk' | 'plain' | undefined) ?? 'sdk');
  const offline = opts.offline ?? process.env.DOCSQA_OFFLINE === '1';
  const chunks = loadCorpus();
  const embedder = cachedEmbedder(offline ? undefined : nomicEmbedder(), CACHE_FILE, { offline });

  if (kind === 'sdk') {
    // Warm the cache with batched calls first: the SDK's add() embeds one text per call.
    await embedder.embed(chunks.map(embedText));
    embedder.save();
    const memory = inMemoryVectorMemory({ embedder, minScore: 0 });
    for (const c of chunks) {
      await memory.add('docs', { text: embedText(c), metadata: { file: c.file, heading: c.heading, section: c.section } });
    }
    return {
      kind,
      chunks,
      embedder,
      async search(query, k = 5) {
        const items = await memory.list('docs', { query, limit: k });
        embedder.save();
        return items.map((item) => {
          const m = item.metadata as { file: string; heading: string; section: string; score: number };
          return { file: m.file, heading: m.heading, section: m.section, score: m.score, text: item.text };
        });
      },
    };
  }

  const vectors = (await embedder.embed(chunks.map((c) => DOC + embedText(c)))).map(norm);
  embedder.save();
  return {
    kind,
    chunks,
    embedder,
    async search(query, k = 5) {
      const [q] = (await embedder.embed([QUERY + query])).map(norm);
      embedder.save();
      return vectors
        .map((v, i) => {
          let s = 0;
          for (let j = 0; j < v.length; j++) s += v[j] * q[j];
          return { i, s };
        })
        .sort((a, b) => b.s - a.s)
        .slice(0, k)
        .map(({ i, s }) => ({ ...chunks[i], score: Number(s.toFixed(4)) }));
    },
  };
}
