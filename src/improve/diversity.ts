import { harnessFiles } from './harness';
import type { Harness } from './types';

function lines(harness: Harness): Set<string> {
  const found = new Set<string>();
  for (const [path, content] of Object.entries(harnessFiles(harness))) {
    for (const line of content.split(/\r?\n/)) if (line.trim()) found.add(`${path}:${line}`);
  }
  return found;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const union = new Set([...a, ...b]).size;
  if (union === 0) return 1;
  return [...a].filter((line) => b.has(line)).length / union;
}

export function diversity(harnesses: readonly Harness[]): { meanJaccard: number; distinct: number } {
  const distinct = new Set(harnesses.map((harness) => JSON.stringify(Object.entries(harnessFiles(harness)).sort(([a], [b]) => a.localeCompare(b))))).size;
  const sets = harnesses.map(lines);
  const similarities = sets.flatMap((a, i) => sets.slice(i + 1).map((b) => jaccard(a, b)));
  const mean = similarities.length === 0 ? 1 : similarities.reduce((sum, value) => sum + value, 0) / similarities.length;
  return { meanJaccard: Math.round(mean * 10_000) / 10_000, distinct };
}
