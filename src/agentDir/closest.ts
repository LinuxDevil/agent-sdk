/** Edit distance between two short strings (single-row dynamic programming). */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(above + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/** Words people reach for that mean one of our keys but are far from it in spelling. */
const SYNONYMS: Readonly<Record<string, string>> = {
  prompt: 'instructions',
  systemprompt: 'instructions',
  system: 'instructions',
  steps: 'maxSteps',
  concurrency: 'toolConcurrency',
};

/** The candidate that `word` is most plausibly a typo (or synonym) of, if any. */
export function closest(word: string, candidates: readonly string[]): string | undefined {
  const lower = word.toLowerCase();
  const synonym = SYNONYMS[lower];
  if (synonym && candidates.includes(synonym)) return synonym;
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d = distance(lower, candidate.toLowerCase());
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return bestDistance <= Math.max(2, Math.floor(lower.length / 3)) ? best : undefined;
}
