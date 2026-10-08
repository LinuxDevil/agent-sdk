/**
 * Embeddings for the docs index.
 *
 * - `nomicEmbedder()` uses the SDK's `aiSdkEmbedder()` over `@ai-sdk/openai`'s
 *   `.embedding()` pointed at LM Studio.
 * - `cachedEmbedder()` is the workaround for two SDK gaps (see FINDINGS.md):
 *   `inMemoryVectorMemory.add()` embeds one item per HTTP call and cannot take
 *   precomputed vectors, and `lousho eval --replay` does not record embedding
 *   calls a tool makes. A disk cache keyed by sha256(text) fixes both: warm it
 *   with one batched call, and replay never touches the network for a cached
 *   query.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { aiSdkEmbedder, type EmbeddingProvider } from '@lousho/build-ai-agent';
import { LOCAL_BASE_URL, LOCAL_EMBED_MODEL } from '../_shared/local.js';

export function nomicEmbedder(): EmbeddingProvider {
  const openai = createOpenAI({ baseURL: LOCAL_BASE_URL, apiKey: 'lm-studio' });
  return aiSdkEmbedder(openai.embedding(LOCAL_EMBED_MODEL), { id: `lmstudio:${LOCAL_EMBED_MODEL}`, maxBatch: 64 });
}

export interface CachedEmbedder extends EmbeddingProvider {
  stats: { hits: number; misses: number; calls: number };
  save(): void;
}

/** Wrap an embedder with a sha256(text) -> vector disk cache. `offline` throws on a miss instead of calling out. */
export function cachedEmbedder(inner: EmbeddingProvider | undefined, file: string, opts: { offline?: boolean } = {}): CachedEmbedder {
  const cache = new Map<string, number[]>();
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
    for (const [k, b64] of Object.entries(raw)) cache.set(k, Array.from(new Float32Array(Buffer.from(b64, 'base64').buffer.slice(0))));
  }
  const key = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 32);
  const stats = { hits: 0, misses: 0, calls: 0 };
  let dirty = false;
  const id = inner?.id ?? 'lmstudio:' + 'text-embedding-nomic-embed-text-v1.5';
  return {
    id,
    stats,
    async embed(texts, options) {
      const missing = [...new Set(texts.filter((t) => !cache.has(key(t))))];
      stats.hits += texts.length - missing.length;
      stats.misses += missing.length;
      if (missing.length) {
        if (opts.offline || !inner) throw new Error(`cachedEmbedder: ${missing.length} text(s) not in ${path.basename(file)} and offline (first: ${JSON.stringify(missing[0].slice(0, 60))})`);
        stats.calls++;
        const vectors = await inner.embed(missing, options);
        missing.forEach((t, i) => cache.set(key(t), vectors[i]));
        dirty = true;
      }
      return texts.map((t) => cache.get(key(t))!);
    },
    save() {
      if (!dirty) return;
      // Merge with what other processes wrote meanwhile (evals and the CLI share this file).
      const out: Record<string, string> = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>) : {};
      for (const [k, v] of [...cache].sort(([a], [b]) => a.localeCompare(b))) out[k] = Buffer.from(new Float32Array(v).buffer).toString('base64');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(out));
      dirty = false;
    },
  };
}
