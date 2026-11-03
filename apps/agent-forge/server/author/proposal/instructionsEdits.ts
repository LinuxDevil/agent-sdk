/**
 * `applyInstructionsEdits` - the anchored edits `proposeAgentUpdate`'s
 * `instructionsEdits` input resolves against the current instructions
 * text (research §4.1 `systemPromptEdits`). Each `oldText` is an anchor:
 * it must occur exactly once so the model can never rewrite a passage it
 * did not point at, and two anchors may not cover overlapping text. All
 * anchors resolve against the ORIGINAL text, then apply right-to-left so
 * an earlier splice cannot shift a later anchor's span.
 *
 * A failure names the edit index (and the other edit or the occurrence
 * count) so the tool can build the `ANCHOR_*` failure the model retries
 * from - the failure's `currentInstructions` is the caller's job, since
 * only it knows which text the edits were tried against.
 */
export interface InstructionsEdit {
  /** Text copied verbatim from the current instructions; must occur exactly once. */
  oldText: string;
  /** The replacement; an empty string deletes `oldText`. */
  newText: string;
}

/** The applied text, or why the anchor set is not usable. `index` is the 0-based edit at fault. */
export type EditsResult =
  | { ok: true; text: string }
  | {
      ok: false;
      code: 'ANCHOR_NOT_FOUND' | 'ANCHOR_AMBIGUOUS' | 'ANCHOR_OVERLAP';
      index: number;
      /** ANCHOR_OVERLAP only: the other edit `index` collides with. */
      otherIndex?: number;
      /** ANCHOR_AMBIGUOUS only: how many times the anchor occurs. */
      occurrences?: number;
    };

/** Every `[start, end)` span `anchor` covers in `text` (non-overlapping occurrences, in order). */
function spansOf(text: string, anchor: string): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(anchor, from);
    if (start === -1) return spans;
    spans.push([start, start + anchor.length]);
    from = start + anchor.length;
  }
}

/** The first overlapping edit pair, or `null` - `[i, j]` with `i < j`, edit order. */
function firstOverlap(spans: readonly (readonly [number, number])[]): readonly [number, number] | null {
  for (let i = 0; i < spans.length; i += 1) {
    for (let j = i + 1; j < spans.length; j += 1) {
      const a = spans[i]!;
      const b = spans[j]!;
      if (a[0] < b[1] && b[0] < a[1]) return [i, j];
    }
  }
  return null;
}

/**
 * Applies `edits` to `text`: every `oldText` must match exactly once and
 * no two matches may overlap (adjacent is fine). Returns the new text, or
 * the first `ANCHOR_*` problem in edit order - anchors are validated
 * before any overlap check so a missing or ambiguous anchor always
 * outranks a collision between well-formed ones.
 */
export function applyInstructionsEdits(text: string, edits: readonly InstructionsEdit[]): EditsResult {
  const spans: Array<readonly [number, number]> = [];
  for (let i = 0; i < edits.length; i += 1) {
    const found = spansOf(text, edits[i]!.oldText);
    if (found.length === 0) return { ok: false, code: 'ANCHOR_NOT_FOUND', index: i };
    if (found.length > 1) {
      return { ok: false, code: 'ANCHOR_AMBIGUOUS', index: i, occurrences: found.length };
    }
    spans.push(found[0]!);
  }
  const overlap = firstOverlap(spans);
  if (overlap !== null) return { ok: false, code: 'ANCHOR_OVERLAP', index: overlap[0], otherIndex: overlap[1] };
  const ordered = edits
    .map((edit, i) => ({ edit, span: spans[i]! }))
    .sort((a, b) => b.span[0] - a.span[0]);
  let result = text;
  for (const { edit, span } of ordered) {
    result = result.slice(0, span[0]) + edit.newText + result.slice(span[1]);
  }
  return { ok: true, text: result };
}
