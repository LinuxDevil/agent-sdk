/**
 * Repro: inMemoryVectorMemory.add() makes one embedding HTTP call per item and
 * has no addMany()/precomputed-vector path. Compares 64 add() calls with one
 * batched embed() of the same 64 texts, against the real LM Studio endpoint.
 */
import { inMemoryVectorMemory, type EmbeddingProvider } from '@lousho/build-ai-agent';
import { loadCorpus } from '../corpus.js';
import { nomicEmbedder } from '../embedder.js';

const inner = nomicEmbedder();
let calls = 0;
const counting: EmbeddingProvider = { id: inner.id, embed: (t, o) => { calls++; return inner.embed(t, o); } };
const texts = loadCorpus().slice(0, 64).map((c) => `${c.heading}\n\n${c.text}`);

let t = Date.now();
const memory = inMemoryVectorMemory({ embedder: counting });
for (const text of texts) await memory.add('docs', { text });
console.log(`64 x add():      ${Date.now() - t} ms, ${calls} embed calls`);

calls = 0; t = Date.now();
await counting.embed(texts);
console.log(`1 x embed(64):   ${Date.now() - t} ms, ${calls} embed call`);
console.log('exported vector API:', Object.keys(await import('@lousho/build-ai-agent')).filter((k) => /vector|embed|retriev|rag|chunk/i.test(k)));
