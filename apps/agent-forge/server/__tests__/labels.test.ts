/**
 * `shared/labels.ts` - the label normalisation `PATCH /agents/:id/meta`
 * applies before storing (and the same module the label UI reuses, so
 * the rules only exist once).
 */
import { describe, it, expect } from 'vitest';
import { labelsProblem, MAX_LABEL_LENGTH, MAX_LABELS, normalizeLabels } from '../../shared/labels';

describe('normalizeLabels', () => {
  it('trims, lowercases, drops empties, dedupes (first wins) and keeps order', () => {
    expect(normalizeLabels([' Ops ', 'ops', 'Billing', '', '   ', 'OPS', 'Core'])).toEqual([
      'ops',
      'billing',
      'core',
    ]);
  });

  it('answers [] for empty and all-empty input', () => {
    expect(normalizeLabels([])).toEqual([]);
    expect(normalizeLabels(['', '  '])).toEqual([]);
  });
});

describe('labelsProblem', () => {
  it('is undefined for a valid normalised list', () => {
    expect(labelsProblem(['ops', 'billing'])).toBeUndefined();
    expect(labelsProblem([])).toBeUndefined();
  });

  it(`names the ${MAX_LABELS}-label cap`, () => {
    const many = Array.from({ length: MAX_LABELS + 1 }, (_, index) => `label-${index}`);
    expect(labelsProblem(many)).toContain(`${MAX_LABELS}`);
  });

  it(`names the ${MAX_LABEL_LENGTH}-char cap`, () => {
    expect(labelsProblem(['x'.repeat(MAX_LABEL_LENGTH + 1)])).toContain(`${MAX_LABEL_LENGTH}`);
  });

  it('accepts exactly the caps', () => {
    const atCap = Array.from({ length: MAX_LABELS }, (_, index) => `label-${index}`);
    expect(labelsProblem(atCap)).toBeUndefined();
    expect(labelsProblem(['x'.repeat(MAX_LABEL_LENGTH)])).toBeUndefined();
  });
});
