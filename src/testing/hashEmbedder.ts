import type { EmbeddingProvider } from '../memory/embeddings';

/** Options of {@link hashEmbedder}. */
export interface HashEmbedderOptions {
  /** Vector length. Default 256. */
  dimensions?: number;
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'to', 'of', 'and', 'or', 'in', 'on', 'it', 'does', 'do', 'what', 'who', 'how']);

/** The word with a plural or verb ending removed, so "likes" and "like" meet. */
function stem(word: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
}

/** FNV-1a, 32 bit. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * A deterministic offline `EmbeddingProvider` for tests and docs: a hashed
 * bag of lower-cased word stems, scaled to unit length. Texts that share
 * words are close ("vegetarian" and "vegetarian food"); texts that mean the
 * same with other words are not. It is not a semantic model.
 *
 * @example
 * ```ts
 * const memory = inMemoryVectorMemory({ embedder: hashEmbedder() });
 * ```
 */
export function hashEmbedder({ dimensions = 256 }: HashEmbedderOptions = {}): EmbeddingProvider {
  if (!Number.isInteger(dimensions) || dimensions < 1) throw new RangeError(`hashEmbedder: dimensions must be a positive integer, got ${dimensions}.`);
  return {
    id: `hash:${dimensions}`,
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Array<number>(dimensions).fill(0);
        for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
          if (word && !STOP_WORDS.has(word)) vector[hash(stem(word)) % dimensions] += 1;
        }
        let sum = 0;
        for (const x of vector) sum += x * x;
        const length = Math.sqrt(sum);
        return length > 0 ? vector.map((x) => x / length) : vector;
      });
    },
  };
}
