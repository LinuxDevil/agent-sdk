/**
 * Client-side label rules for the detail header's labels editor (A09): the
 * same normalisation PLAN §4 gives `AgentMeta.labels` (trimmed, lowercased,
 * inner whitespace collapsed to `-`, ≤ 20 labels, ≤ 32 chars, deduped). L13
 * owns the server side and may later move this to `shared/`.
 */

/** The most labels one agent may carry. */
export const MAX_LABELS = 20;
/** The longest one label may be, in characters. */
export const MAX_LABEL_LENGTH = 32;

/** One label as the server stores it: trimmed, lowercased, inner whitespace → '-'. Empty → ''. */
export function normalizeLabel(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Adds `raw` (may hold several comma-separated labels) to `labels`; returns
 * the new list and the first problem, if any. Pieces normalise through
 * {@link normalizeLabel}; empties are skipped. Valid pieces before a problem
 * stay added; processing stops at the first problem.
 * Problems (exact): 'Labels can be at most 32 characters.', 'At most 20 labels.', '“{label}” is already added.'
 */
export function addLabels(labels: string[], raw: string): { labels: string[]; problem?: string } {
  const next = [...labels];
  for (const piece of raw.split(',')) {
    const label = normalizeLabel(piece);
    if (label === '') continue;
    if (label.length > MAX_LABEL_LENGTH) {
      return { labels: next, problem: 'Labels can be at most 32 characters.' };
    }
    if (next.includes(label)) {
      return { labels: next, problem: `“${label}” is already added.` };
    }
    if (next.length >= MAX_LABELS) {
      return { labels: next, problem: 'At most 20 labels.' };
    }
    next.push(label);
  }
  return { labels: next };
}
