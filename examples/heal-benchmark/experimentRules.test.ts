import { describe, expect, it } from 'vitest';
import { admissionFailure, replayable, requireModels } from './experimentRules';

describe('experiment rules', () => {
  it('requires both --model and --editor, with no default', () => {
    expect(() => requireModels({})).toThrow('experiment.ts needs --model <id> and --editor <id>.');
    expect(() => requireModels({ model: 'stealth/crouton-alpha' })).toThrow(/--editor/);
    expect(() => requireModels({ editor: 'stealth/crouton-alpha' })).toThrow(/--model/);
    expect(() => requireModels({ model: '', editor: 'x' })).toThrow(/--model/);
    expect(requireModels({ model: 'a', editor: 'b' })).toEqual({ model: 'a', editor: 'b' });
  });

  it('replays only rows that ended in a proposal or kept the base, and lists the rest', () => {
    const rows = [
      { attempt: 0, outcome: 'proposal' },
      { attempt: 1, outcome: 'keep-base' },
      { attempt: 2, outcome: 'outage' },
      { attempt: 3, outcome: 'no-failures' },
      { attempt: 4 },
    ];
    const { kept, skipped } = replayable(rows);
    expect(kept.map((row) => row.attempt)).toEqual([0, 1]);
    expect(skipped).toEqual(['attempt 2: outage', 'attempt 3: no-failures', 'attempt 4: no outcome']);
  });

  it('refuses to start unless every held-out case passed 6/6 on the base', () => {
    expect(admissionFailure([{ caseId: 'page-count', passed: 6, scored: 6 }], 6)).toBeUndefined();
    expect(admissionFailure([{ caseId: 'page-count', passed: 6, scored: 6 }, { caseId: 'round-root-cause', passed: 5, scored: 6 }], 6)).toBe('Held-out case round-root-cause passed 5/6 on the base, below 6/6, so the arms run will not start. Run --admit and choose admitted cases.');
    expect(admissionFailure([{ caseId: 'page-count', passed: 5, scored: 5 }], 6)).toMatch(/page-count passed 5\/5/);
    expect(admissionFailure([], 6)).toBe('The arms run needs at least one --holdout case.');
  });
});
