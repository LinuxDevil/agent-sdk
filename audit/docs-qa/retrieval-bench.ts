/**
 * Retrieval quality and indexing cost: SDK `inMemoryVectorMemory` vs a plain
 * store with nomic query/document prefixes, same chunks, same model.
 * Run: npx tsx docs-qa/retrieval-bench.ts
 */
import { GOLDEN } from './golden.js';
import { buildRetriever } from './retriever.js';

for (const kind of ['plain', 'sdk'] as const) {
  const t0 = Date.now();
  const r = await buildRetriever({ kind });
  const buildMs = Date.now() - t0;
  let hit1 = 0;
  let hit5 = 0;
  let mrr = 0;
  const rows: string[] = [];
  for (const g of GOLDEN) {
    const hits = await r.search(g.input, 5);
    const rank = hits.findIndex((h) => g.expectFiles.includes(h.file));
    if (rank === 0) hit1++;
    if (rank >= 0) {
      hit5++;
      mrr += 1 / (rank + 1);
    }
    rows.push(`  ${g.label.padEnd(18)} rank=${rank < 0 ? '-' : rank + 1}  top=${hits[0]?.file}#${hits[0]?.section} (${hits[0]?.score.toFixed(3)})`);
  }
  console.log(
    `[${kind}] chunks=${r.chunks.length} build=${buildMs}ms embedCalls=${r.embedder.stats.calls} hits=${r.embedder.stats.hits} misses=${r.embedder.stats.misses}`
  );
  console.log(rows.join('\n'));
  console.log(`  recall@1=${hit1}/${GOLDEN.length} recall@5=${hit5}/${GOLDEN.length} MRR=${(mrr / GOLDEN.length).toFixed(3)}`);
}
