/**
 * Agent label rules, shared by the server (`PATCH /agents/:id/meta`
 * normalises before storing in `meta.json`) and the browser client (the
 * label editor and label filters) - one module so both ends apply the
 * same caps and the same normalisation.
 */

/** `meta.json` holds at most this many labels per agent. */
export const MAX_LABELS = 20;

/** One label is at most this many characters (after normalisation). */
export const MAX_LABEL_LENGTH = 32;

/**
 * Trim, lowercase, drop empties, dedupe (first wins), keep order. Applied
 * to every label list before it is stored or compared, so `' Ops '` and
 * `'ops'` are the same label.
 */
export function normalizeLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    const label = raw.trim().toLowerCase();
    if (label === '' || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

/**
 * The plain-words problem with a normalised label list, or `undefined`
 * when it is valid: more than {@link MAX_LABELS} labels, or a label over
 * {@link MAX_LABEL_LENGTH} chars.
 */
export function labelsProblem(labels: readonly string[]): string | undefined {
  if (labels.length > MAX_LABELS) return `Use at most ${MAX_LABELS} labels.`;
  const tooLong = labels.find((label) => label.length > MAX_LABEL_LENGTH);
  if (tooLong !== undefined) return `Labels can be at most ${MAX_LABEL_LENGTH} characters.`;
  return undefined;
}
