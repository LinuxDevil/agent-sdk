import { describe, expect, it } from 'vitest';
import type { LabelledRun } from './evidence';
import { caseCount, judgeTrainingCase, MIN_CASE_GAIN, trainingFailure, type JudgedCase } from './gate';
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
