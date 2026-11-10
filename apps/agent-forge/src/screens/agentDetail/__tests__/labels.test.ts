import { describe, expect, it } from 'vitest';

import { addLabels, MAX_LABEL_LENGTH, MAX_LABELS, normalizeLabel } from '../labels';

describe('normalizeLabel', () => {
  it('trims, lowercases and turns inner whitespace into dashes', () => {
    expect(normalizeLabel('  Tier One ')).toBe('tier-one');
    expect(normalizeLabel('Billing\tOps')).toBe('billing-ops');
    expect(normalizeLabel('   ')).toBe('');
  });
});

describe('addLabels', () => {
  it('adds several comma-separated labels, normalised', () => {
    expect(addLabels(['a'], 'B, c')).toEqual({ labels: ['a', 'b', 'c'] });
  });

  it('reports a duplicate and leaves the list unchanged', () => {
    expect(addLabels(['a'], 'A')).toEqual({ labels: ['a'], problem: '“a” is already added.' });
  });

  it('rejects a label over 32 characters', () => {
    expect(addLabels([], 'x'.repeat(MAX_LABEL_LENGTH + 1))).toEqual({
      labels: [],
      problem: 'Labels can be at most 32 characters.',
    });
  });

  it('rejects a 21st label', () => {
    const labels = Array.from({ length: MAX_LABELS }, (_, i) => `l${i}`);
    expect(addLabels(labels, 'y')).toEqual({ labels, problem: 'At most 20 labels.' });
  });

  it('ignores blank input without a problem', () => {
    expect(addLabels(['a'], '  ')).toEqual({ labels: ['a'] });
  });
});
