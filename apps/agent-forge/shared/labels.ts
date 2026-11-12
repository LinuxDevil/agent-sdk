/**
 * Agent label rules, shared by the server (`PATCH /agents/:id/meta`,
 * draft approve, template create) and the browser client (the labels
 * editor and the Agents-list facet) - one module so both ends apply the
 * same caps and the same normalisation (PLAN §4:
 * `labels: string[] // lowercase, trimmed, ≤ 20 labels, ≤ 32 chars each,
 * deduped`). Dependency-free: `shared/` compiles into both bundles.
 */

/** `meta.json` holds at most this many labels per agent. */
export const MAX_LABELS = 20;

/** One label is at most this many characters (after normalisation). */
export const MAX_LABEL_LENGTH = 32;

/** A label list that violates the rules; `message` is the user-facing 400 text. */
export class LabelError extends Error {}

/**
 * Trim, collapse inner whitespace to one space, lowercase, drop empties,
 * dedupe keeping first-seen order, then enforce the caps. `input` is
 * `unknown` so the server can hand it the raw request field: a non-array
 * or a non-string entry throws {@link LabelError} `'Labels must be text.'`;
 * more than {@link MAX_LABELS} labels throws `'An agent can have at most
 * 20 labels.'`; a label over {@link MAX_LABEL_LENGTH} chars throws
 * `'Label "<label>" is longer than 32 characters.'`.
 */
export function normalizeLabels(input: unknown): string[] {
  if (!Array.isArray(input)) throw new LabelError('Labels must be text.');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') throw new LabelError('Labels must be text.');
    const label = raw.trim().replace(/\s+/g, ' ').toLowerCase();
    if (label === '' || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  if (out.length > MAX_LABELS) throw new LabelError(`An agent can have at most ${MAX_LABELS} labels.`);
  const tooLong = out.find((label) => label.length > MAX_LABEL_LENGTH);
  if (tooLong !== undefined) {
    throw new LabelError(`Label "${tooLong}" is longer than ${MAX_LABEL_LENGTH} characters.`);
  }
  return out;
}

/**
 * Sorted distinct labels with the number of agents carrying each - the
 * Labels facet's options. An agent whose stored labels fail
 * {@link normalizeLabels} (a hand-edited `meta.json`) is skipped rather
 * than breaking the whole facet.
 */
export function labelFacetOptions(
  items: Array<{ labels: string[] }>
): Array<{ value: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    let labels: string[];
    try {
      labels = normalizeLabels(item.labels);
    } catch {
      continue;
    }
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * True when `selected` is empty or the item carries at least one selected
 * label (the facet's OR semantics). Both sides are normalised, so `'Ops'`
 * matches a stored `'ops'`; a list that fails normalisation simply does
 * not match - a filter predicate never throws.
 */
export function matchesLabels(itemLabels: string[], selected: string[]): boolean {
  if (selected.length === 0) return true;
  try {
    const own = new Set(normalizeLabels(itemLabels));
    return normalizeLabels(selected).some((label) => own.has(label));
  } catch {
    return false;
  }
}
