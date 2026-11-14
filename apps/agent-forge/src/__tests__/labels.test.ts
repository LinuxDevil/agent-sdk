/**
 * `shared/labels.ts` - the one label rule both ends apply (L13): the
 * server PATCH/draft-approve paths and the client editor/facet all go
 * through `normalizeLabels`, `labelFacetOptions` and `matchesLabels`.
 * `shared/` sits outside both vitest include globs, so the test lives
 * under `src/` and imports it directly.
 */
import { describe, expect, it } from 'vitest';

import { labelFacetOptions, LabelError, matchesLabels, MAX_LABEL_LENGTH, MAX_LABELS, normalizeLabels } from '../../shared/labels';

describe('normalizeLabels', () => {
  it('trims, collapses inner whitespace, lowercases, drops empties and dedupes first-seen', () => {
    expect(normalizeLabels(['  Support ', 'support', 'Billing  Ops', ''])).toEqual(['support', 'billing ops']);
    expect(normalizeLabels(['Ops', 'OPS', 'ops'])).toEqual(['ops']);
    expect(normalizeLabels(['a\tb\nc'])).toEqual(['a b c']);
  });

  it('answers [] for empty and all-empty input', () => {
    expect(normalizeLabels([])).toEqual([]);
    expect(normalizeLabels(['', '   '])).toEqual([]);
  });

  it('throws LabelError "Labels must be text." for a non-array or a non-string entry', () => {
    expect(() => normalizeLabels('ops')).toThrow(LabelError);
    expect(() => normalizeLabels('ops')).toThrow('Labels must be text.');
    expect(() => normalizeLabels(['ok', 7])).toThrow('Labels must be text.');
    expect(() => normalizeLabels(null)).toThrow('Labels must be text.');
  });

  it('throws LabelError naming the 20-label cap', () => {
    const many = Array.from({ length: MAX_LABELS + 1 }, (_, i) => `l${i}`);
    expect(() => normalizeLabels(many)).toThrow(`An agent can have at most ${MAX_LABELS} labels.`);
    // Dedupe happens first: 21 raw entries collapsing to 20 are fine.
    const deduped = [...Array.from({ length: MAX_LABELS }, (_, i) => `l${i}`), 'L0'];
    expect(normalizeLabels(deduped)).toHaveLength(MAX_LABELS);
  });

  it('throws LabelError naming the 32-char cap with the offending label', () => {
    const tooLong = 'x'.repeat(MAX_LABEL_LENGTH + 1);
    expect(() => normalizeLabels([tooLong])).toThrow(`Label "${tooLong}" is longer than ${MAX_LABEL_LENGTH} characters.`);
    expect(normalizeLabels(['x'.repeat(MAX_LABEL_LENGTH)])).toHaveLength(1);
  });
});

describe('labelFacetOptions', () => {
  it('lists distinct normalised labels sorted alphabetically with counts', () => {
    const items = [
      { labels: ['Billing', 'GitHub'] },
      { labels: ['billing', 'Ops'] },
      { labels: [] },
    ];
    expect(labelFacetOptions(items)).toEqual([
      { value: 'billing', label: 'billing', count: 2 },
      { value: 'github', label: 'github', count: 1 },
      { value: 'ops', label: 'ops', count: 1 },
    ]);
  });

  it('skips an agent whose stored labels fail normalisation', () => {
    const items = [{ labels: ['ok'] }, { labels: ['x'.repeat(40)] }];
    expect(labelFacetOptions(items)).toEqual([{ value: 'ok', label: 'ok', count: 1 }]);
  });
});

describe('matchesLabels', () => {
  it('is true for an empty selection and for any overlap (OR)', () => {
    expect(matchesLabels(['a'], [])).toBe(true);
    expect(matchesLabels(['a', 'b'], ['b', 'c'])).toBe(true);
    expect(matchesLabels(['a'], ['b', 'c'])).toBe(false);
  });

  it('normalises both sides', () => {
    expect(matchesLabels(['Billing Ops'], ['billing  ops'])).toBe(true);
  });

  it('never throws: an invalid list simply does not match', () => {
    expect(matchesLabels(['x'.repeat(40)], ['y'])).toBe(false);
  });
});
