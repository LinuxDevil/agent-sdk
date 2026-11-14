import { describe, expect, it } from 'vitest';
import type { LabelledRun } from './evidence';
import { caseCount, costNote, HOLDOUT_RERUNS, holdoutFailure, judgeHoldoutCase, judgePooledHoldout, judgeTrainingCase, MIN_CASE_GAIN, trainingFailure, type JudgedCase } from './gate';
import type { CaseCount } from './types';

const runs = (caseId: string, results: (boolean | null)[]): LabelledRun[] =>
  results.map((passed, repeat) => ({ label: 'x', caseId, repeat, run: { passed, transcript: '', tokens: 10, ended: 'stop' } }));

const T = true;
const F = false;

const judged = (caseId: string, base: (boolean | null)[], final: (boolean | null)[]): JudgedCase =>
  judgeTrainingCase(caseId, caseCount(runs(caseId, base), caseId), caseCount(runs(caseId, final), caseId));

describe('caseCount', () => {
  it('counts only the scored runs of the named case', () => {
    expect(caseCount([...runs('c', [T, null, F]), ...runs('d', [T, T])], 'c')).toEqual({ passed: 1, scored: 2 });
  });
});

describe('judgeTrainingCase', () => {
  it.each([
    { base: [F, F, F], final: [T, T, F], improved: true, dropped: false, scorable: true, reason: /improved from 0\/3 to 2\/3/i },
    { base: [F, F, F], final: [T, F, F], improved: false, dropped: false, scorable: true, reason: /less than the 2-in-3/i },
    { base: [T, F, F], final: [T, T, T], improved: true, dropped: false, scorable: true, reason: /improved from 1\/3 to 3\/3/i },
    { base: [T, T, T], final: [T, T, F], improved: false, dropped: true, scorable: true, reason: /got worse/i },
    { base: [F, F, F], final: [F, F, F], improved: false, dropped: false, scorable: true, reason: /failed under both/i },
    { base: [null, null, null], final: [T, T, T], improved: false, dropped: false, scorable: false, reason: /could not be scored/i },
    { base: [T, null, F], final: [T, T, null], improved: false, dropped: false, scorable: true, reason: /less than/i },
    { base: [F, null, null], final: [T, null, null], improved: false, dropped: false, scorable: true, reason: /too few scored runs/i },
    { base: [F, F, null], final: [T, T, null], improved: true, dropped: false, scorable: true, reason: /improved from 0\/2 to 2\/2/i },
  ])('judges $base to $final', ({ base, final, improved, dropped, scorable, reason }) => {
    const result = judged('c', base, final);
    expect(result).toMatchObject({ improved, dropped, scorable });
    expect(result.verdict.caseId).toBe('c');
    expect(result.verdict.role).toBe('training');
    expect(result.verdict.reasons).toHaveLength(1);
    expect(result.verdict.reasons[0]).toMatch(reason);
  });

  it('counts a gain of exactly MIN_CASE_GAIN, and nothing below it', () => {
    const gain = (base: CaseCount, final: CaseCount) => judgeTrainingCase('c', base, final).improved;
    expect(MIN_CASE_GAIN).toBe(2 / 3);
    expect(gain({ passed: 1, scored: 3 }, { passed: 3, scored: 3 })).toBe(true);
    expect(gain({ passed: 1, scored: 6 }, { passed: 5, scored: 6 })).toBe(true);
    expect(gain({ passed: 0, scored: 1000 }, { passed: 666, scored: 1000 })).toBe(false);
  });

  it('improves exactly when 3 scored runs gain 2 or more, and drops exactly when they lose any', () => {
    for (let basePassed = 0; basePassed <= 3; basePassed += 1) {
      for (let finalPassed = 0; finalPassed <= 3; finalPassed += 1) {
        const result = judgeTrainingCase('c', { passed: basePassed, scored: 3 }, { passed: finalPassed, scored: 3 });
        expect(result.improved).toBe(finalPassed - basePassed >= 2);
        expect(result.dropped).toBe(finalPassed < basePassed);
      }
    }
  });
});

describe('trainingFailure', () => {
  it.each([
    { name: 'one improved and none dropped', cases: [judged('a', [F, F, F], [T, T, T]), judged('b', [T, T, T], [T, T, T])], expected: undefined },
    { name: 'one improved and one dropped', cases: [judged('a', [F, F, F], [T, T, T]), judged('b', [T, T, T], [T, T, F])], expected: /got worse \(b\)/ },
    { name: 'none improved', cases: [judged('a', [F, F, F], [T, F, F])], expected: /no training case improved/i },
    { name: 'all unscorable', cases: [judged('a', [null, null, null], [T, T, T])], expected: /could not be scored/i },
  ])('$name', ({ cases, expected }) => {
    const failure = trainingFailure(cases);
    if (expected === undefined) expect(failure).toBeUndefined();
    else expect(failure).toMatch(expected);
  });

  it('never accepts a no-op on a training case', () => {
    const values = [true, false, null] as const;
    const patterns = values.flatMap((a) => values.flatMap((b) => values.map((c) => [a, b, c])));
    expect(patterns).toHaveLength(27);
    for (const pattern of patterns) {
      const count = caseCount(runs('c', pattern), 'c');
      expect(trainingFailure([judgeTrainingCase('c', count, count)])).toBeDefined();
    }
  });
});

const count = (ratio: string): CaseCount => {
  const [passed, scored] = ratio.split('/').map(Number);
  return { passed, scored };
};

describe('judgeHoldoutCase', () => {
  it.each([
    { base: '3/3', final: '3/3', needsRerun: false, reason: /held: 3\/3 before, 3\/3 after/i },
    { base: '3/3', final: '2/3', needsRerun: true, reason: /dropped from 3\/3 to 2\/3, so both harnesses ran 3 more times/i },
    { base: '2/3', final: '3/3', needsRerun: false, reason: /held/i },
    { base: '0/3', final: '0/3', needsRerun: false, reason: /failed under both/i },
    { base: '0/0', final: '3/3', needsRerun: false, reason: /could not be scored/i },
  ])('judges $base to $final', ({ base, final, needsRerun, reason }) => {
    const result = judgeHoldoutCase('h', count(base), count(final));
    expect(result.needsRerun).toBe(needsRerun);
    expect(result.verdict).toMatchObject({ caseId: 'h', role: 'holdout', base: count(base), final: count(final) });
    expect(result.verdict.reasons).toHaveLength(1);
    expect(result.verdict.reasons[0]).toMatch(reason);
  });
});

describe('judgePooledHoldout', () => {
  it.each([
    { base: '6/6', final: '5/6', regressed: false, reason: /pooled 6\/6 to 5\/6: within chance/i },
    { base: '6/6', final: '4/6', regressed: true, reason: /pooled 6\/6 to 4\/6: a regression/i },
    { base: '5/6', final: '3/6', regressed: true, reason: /a regression/i },
    { base: '4/6', final: '3/6', regressed: false, reason: /within chance/i },
    { base: '6/6', final: '4/5', regressed: false, reason: /within chance/i },
    { base: '6/6', final: '0/0', regressed: false, reason: /could not be scored/i },
  ])('judges pooled $base to $final', ({ base, final, regressed, reason }) => {
    const first = judgeHoldoutCase('h', count('3/3'), count('2/3')).verdict;
    const result = judgePooledHoldout('h', count(base), count(final), 3, first);
    expect(result.regressed).toBe(regressed);
    expect(result.verdict).toMatchObject({ caseId: 'h', role: 'holdout', base: count(base), final: count(final) });
    expect(result.verdict.reasons).toEqual([first.reasons[0], expect.stringMatching(reason)]);
  });

  it('reruns 3 times per harness', () => {
    expect(HOLDOUT_RERUNS).toBe(3);
  });
});

describe('holdoutFailure', () => {
  it('names the regressed cases, and passes when there are none', () => {
    expect(holdoutFailure([])).toBeUndefined();
    expect(holdoutFailure(['a', 'b'])).toBe('A held-out case got worse over the pooled runs (a, b).');
  });
});

describe('costNote', () => {
  it('reports the cost change, or says it could not be compared', () => {
    expect(costNote({ cases: 2, base: 10.4, final: 14.6, noise: 1.2 })).toBe(' Cost per passing run went from 10 to 15 tokens (noise 1).');
    expect(costNote(undefined)).toBe(' Cost could not be compared, because no case passed under both harnesses.');
  });
});
