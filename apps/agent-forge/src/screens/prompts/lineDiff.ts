/**
 * A small line diff for prompt versions: the longest common subsequence of
 * lines, with removed lines emitted before added ones at each change, then
 * paired into side-by-side rows.
 *
 * Common leading and trailing lines are trimmed first, so the quadratic LCS
 * table only covers the changed middle. When that middle is longer than
 * {@link MAX_DIFF_LINES} on either side (prompts are small; this guards a
 * pasted document), the diff falls back to a whole-block one - every middle
 * line of A removed, every middle line of B added - and says so with
 * `wholeBlock`, rather than allocating a multi-megabyte table on the UI thread.
 */

/** The changed-middle size (lines, per side) above which the diff is whole-block. */
export const MAX_DIFF_LINES = 2000;

/** One diff line: `a`/`b` are its 1-based line numbers in the old/new text (absent on the side it is not in). */
export interface DiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
  a?: number;
  b?: number;
}

/** One side of a side-by-side row. */
export interface DiffCell {
  n: number;
  text: string;
  kind: DiffLine['kind'];
}

/** A side-by-side row: the old line on the left, the new on the right; a missing side is padding. */
export interface DiffRow {
  left: DiffCell | undefined;
  right: DiffCell | undefined;
}

const splitLines = (text: string): string[] => (text === '' ? [] : text.split(/\r?\n/));

/** The LCS walk over `a`/`b` (already trimmed), as kinds in order. */
function lcsKinds(a: string[], b: string[]): DiffLine['kind'][] {
  const cols = b.length + 1;
  // suffix[i * cols + j] = LCS length of a[i..] and b[j..]; Uint16 fits MAX_DIFF_LINES.
  const suffix = new Uint16Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      suffix[i * cols + j] =
        a[i] === b[j] ? suffix[(i + 1) * cols + j + 1] + 1 : Math.max(suffix[(i + 1) * cols + j], suffix[i * cols + j + 1]);
    }
  }
  const kinds: DiffLine['kind'][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      kinds.push('same');
      i++;
      j++;
    } else if (suffix[(i + 1) * cols + j] >= suffix[i * cols + j + 1]) {
      kinds.push('removed');
      i++;
    } else {
      kinds.push('added');
      j++;
    }
  }
  for (; i < a.length; i++) kinds.push('removed');
  for (; j < b.length; j++) kinds.push('added');
  return kinds;
}

/** The kinds for the changed middle: an LCS walk, or all-removed-then-all-added past the cap. */
function middleKinds(a: string[], b: string[]): { kinds: DiffLine['kind'][]; wholeBlock: boolean } {
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return { kinds: [...a.map(() => 'removed' as const), ...b.map(() => 'added' as const)], wholeBlock: true };
  }
  return { kinds: lcsKinds(a, b), wholeBlock: false };
}

/** Diff `before` against `after` by line (`\r\n` and `\n` both split). */
export function lineDiff(before: string, after: string): { lines: DiffLine[]; wholeBlock: boolean } {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const { kinds, wholeBlock } = middleKinds(a.slice(head, a.length - tail), b.slice(head, b.length - tail));
  const all: DiffLine['kind'][] = [...Array<'same'>(head).fill('same'), ...kinds, ...Array<'same'>(tail).fill('same')];
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (const kind of all) {
    if (kind === 'same') lines.push({ kind, text: a[i], a: ++i, b: ++j });
    else if (kind === 'removed') lines.push({ kind, text: a[i], a: ++i });
    else lines.push({ kind, text: b[j], b: ++j });
  }
  return { lines, wholeBlock };
}

/** Pair each run of removed lines with the run of added lines right after it; kept lines sit on both sides. */
export function sideBySide(lines: readonly DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let k = 0;
  while (k < lines.length) {
    const line = lines[k];
    if (line.kind === 'same') {
      rows.push({ left: { n: line.a!, text: line.text, kind: 'same' }, right: { n: line.b!, text: line.text, kind: 'same' } });
      k++;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (k < lines.length && lines[k].kind === 'removed') removed.push(lines[k++]);
    while (k < lines.length && lines[k].kind === 'added') added.push(lines[k++]);
    for (let r = 0; r < Math.max(removed.length, added.length); r++) {
      const left = removed[r];
      const right = added[r];
      rows.push({
        left: left && { n: left.a!, text: left.text, kind: 'removed' },
        right: right && { n: right.b!, text: right.text, kind: 'added' },
      });
    }
  }
  return rows;
}
