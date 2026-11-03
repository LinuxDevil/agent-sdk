import { describe, expect, it } from 'vitest';
import { applyInstructionsEdits } from '../instructionsEdits';

/**
 * applyInstructionsEdits (AA09): every `oldText` must occur exactly once,
 * no two anchors may overlap, and the edits apply right-to-left so each
 * splice sees the positions the others were anchored at.
 */

const TEXT = 'alpha beta gamma delta';

describe('applyInstructionsEdits', () => {
  it('applies two edits in one pass, right-to-left', () => {
    const result = applyInstructionsEdits(TEXT, [
      { oldText: 'beta', newText: 'BETA' },
      { oldText: 'delta', newText: 'DELTA' },
    ]);
    expect(result).toEqual({ ok: true, text: 'alpha BETA gamma DELTA' });
  });

  it('anchors on the original text even when an earlier edit changes earlier positions', () => {
    // The second edit's anchor sits after the first's: applying
    // left-to-right with index recomputation would still land correctly,
    // but a shared-replace implementation would break; the contract is a
    // single result computed from the original positions.
    const result = applyInstructionsEdits('do x then do y', [
      { oldText: 'do x', newText: 'DO X LONGER' },
      { oldText: 'do y', newText: 'DO Y' },
    ]);
    expect(result).toEqual({ ok: true, text: 'DO X LONGER then DO Y' });
  });

  it('deletes with an empty newText', () => {
    const result = applyInstructionsEdits(TEXT, [{ oldText: ' beta', newText: '' }]);
    expect(result).toEqual({ ok: true, text: 'alpha gamma delta' });
  });

  it('an absent anchor is ANCHOR_NOT_FOUND at its edit index', () => {
    const result = applyInstructionsEdits(TEXT, [
      { oldText: 'beta', newText: 'BETA' },
      { oldText: 'epsilon', newText: 'EPS' },
    ]);
    expect(result).toEqual({ ok: false, code: 'ANCHOR_NOT_FOUND', index: 1 });
  });

  it('an anchor occurring more than once is ANCHOR_AMBIGUOUS and reports the count', () => {
    const result = applyInstructionsEdits('pick a queue, any queue', [{ oldText: 'queue', newText: 'line' }]);
    expect(result).toEqual({ ok: false, code: 'ANCHOR_AMBIGUOUS', index: 0, occurrences: 2 });
  });

  it('overlapping anchors are ANCHOR_OVERLAP naming both edits', () => {
    const result = applyInstructionsEdits(TEXT, [
      { oldText: 'beta gamma', newText: 'x' },
      { oldText: 'gamma delta', newText: 'y' },
    ]);
    expect(result).toEqual({ ok: false, code: 'ANCHOR_OVERLAP', index: 0, otherIndex: 1 });
  });

  it('adjacent-but-not-overlapping edits succeed', () => {
    const result = applyInstructionsEdits('ab', [
      { oldText: 'a', newText: 'A' },
      { oldText: 'b', newText: 'B' },
    ]);
    expect(result).toEqual({ ok: true, text: 'AB' });
  });
});
