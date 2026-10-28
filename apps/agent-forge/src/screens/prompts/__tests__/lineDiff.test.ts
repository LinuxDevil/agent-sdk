import { describe, expect, it } from 'vitest';

import { MAX_DIFF_LINES, lineDiff, sideBySide } from '../lineDiff';

const NL = '\n';
const kinds =(a: string, b: string) => lineDiff(a, b).lines.map((l) => `${l.kind[0]} ${l.text}`);

describe('lineDiff', () => {
  it('marks kept, removed and added lines with both sides line numbers', () => {
    const { lines, wholeBlock } = lineDiff('a\nb\nc', 'a\nc\nd');
    expect(wholeBlock).toBe(false);
    expect(lines).toEqual([
      { kind: 'same', text: 'a', a: 1, b: 1 },
      { kind: 'removed', text: 'b', a: 2 },
      { kind: 'same', text: 'c', a: 3, b: 2 },
      { kind: 'added', text: 'd', b: 3 },
    ]);
  });

  it('keeps the longest common subsequence, not just a common prefix', () => {
    expect(kinds('x\na\nb\nc', 'a\nb\ny\nc')).toEqual(['r x', 's a', 's b', 'a y', 's c']);
  });

  it('handles identical, empty and one-sided inputs', () => {
    expect(kinds('same\ntext', 'same\ntext')).toEqual(['s same', 's text']);
    expect(kinds('', 'new')).toEqual(['a new']);
    expect(kinds('old', '')).toEqual(['r old']);
    expect(lineDiff('', '').lines).toEqual([]);
    // CRLF and LF texts compare by line content.
    expect(kinds('a\r\nb', 'a\nb')).toEqual(['s a', 's b']);
  });

  it(`falls back to a whole-block diff when the changed middle is over ${MAX_DIFF_LINES} lines`, () => {
    const big = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `line ${i}`).join(NL);
    const { lines, wholeBlock } = lineDiff(big, big.toUpperCase());
    expect(wholeBlock).toBe(true);
    expect(lines.filter((l) => l.kind === 'removed')).toHaveLength(MAX_DIFF_LINES + 1);
    expect(lines.filter((l) => l.kind === 'added')).toHaveLength(MAX_DIFF_LINES + 1);
    expect(lines.some((l) => l.kind === 'same')).toBe(false);
  });

  it('still diffs a long text line by line when only a small middle changed (common ends are trimmed first)', () => {
    const big = Array.from({ length: MAX_DIFF_LINES * 2 }, (_, i) => `line ${i}`);
    const edited = [...big];
    edited[MAX_DIFF_LINES] = 'changed';
    const { lines, wholeBlock } = lineDiff(big.join(NL), edited.join(NL));
    expect(wholeBlock).toBe(false);
    expect(lines.filter((l) => l.kind !== 'same').map((l) => `${l.kind} ${l.text}`)).toEqual([
      `removed line ${MAX_DIFF_LINES}`,
      'added changed',
    ]);
  });
});

describe('sideBySide', () => {
  it('pairs a removed run with the added run after it, and pads the shorter side', () => {
    const rows = sideBySide(lineDiff('a\nb\nc\nz', 'a\nB\nz').lines);
    expect(rows).toEqual([
      { left: { n: 1, text: 'a', kind: 'same' }, right: { n: 1, text: 'a', kind: 'same' } },
      { left: { n: 2, text: 'b', kind: 'removed' }, right: { n: 2, text: 'B', kind: 'added' } },
      { left: { n: 3, text: 'c', kind: 'removed' }, right: undefined },
      { left: { n: 4, text: 'z', kind: 'same' }, right: { n: 3, text: 'z', kind: 'same' } },
    ]);
  });
});
