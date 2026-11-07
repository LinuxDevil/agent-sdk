import { describe, expect, it } from 'vitest';
import { bars, renderReport, trueFixAttempts } from './armSummary';
import type { Arm, ArmRow } from './gates';
import { emptyCounts } from './probeCache';

const row = (arm: Arm, attempt: number, accepted: boolean, passK: ArmRow['passK'] = {}): ArmRow => ({ attempt, arm, accepted, reason: 'r', model: 'm', date: 'd', passK });
const many = (arm: Arm, accepted: readonly boolean[]) => accepted.map((value, attempt) => row(arm, attempt, value));
const ARMS: Arm[] = ['A', 'B', 'C', 'D', 'N', 'P'];

const passing = {
  rows: [
    ...many('A', [true, true, true, true, true]),
    ...many('B', [false, false, false, false, false]),
    ...many('C', [true, true, false, false, false]),
    ...many('D', [true, true, true, false, false]),
    ...many('N', [true, ...Array<boolean>(9).fill(false)]),
    ...many('P', Array<boolean>(10).fill(false)),
  ],
  trueFixes: new Set([0, 1, 2, 3, 4]),
  confirmations: [{ attempt: 0, caseId: 'round-root-cause', passed: 5, scored: 6 }],
  healthy: [{ outcome: 'proposal' }, ...Array(4).fill({ outcome: 'no-failures' })],
  arms: ARMS,
};

describe('arm summary', () => {
  it('marks every plan bar met when the arms clear it', () => {
    const result = bars(passing);
    expect(result).toHaveLength(6);
    expect(result.map((bar) => [bar.met, `${bar.passed}/${bar.total}`])).toEqual([
      [true, '3/5'],
      [true, '1/10'],
      [true, '10/10'],
      [true, '1/1'],
      [true, '4/5'],
      [true, '6/6'],
    ]);
  });

  it('marks each bar missed when the arms fall short', () => {
    const result = bars({
      ...passing,
      rows: [...many('D', [true, true, false, false, false]), ...many('N', [true, true, ...Array<boolean>(8).fill(false)]), ...many('P', [true, true, ...Array<boolean>(8).fill(false)])],
      confirmations: [{ attempt: 0, caseId: 'page-count', passed: 4, scored: 6 }],
      healthy: [],
    });
    expect(result.map((bar) => bar.met)).toEqual([false, false, false, false, false, false]);
  });

  it('needs five true fixes, ten no-op and ten planted attempts before a bar counts as met', () => {
    const result = bars({ ...passing, rows: [...many('D', [true]), ...many('N', [false]), ...many('P', [false])], trueFixes: new Set([0]) });
    expect(result.slice(0, 3).map((bar) => bar.met)).toEqual([false, false, false]);
  });

  it('counts an attempt as a true fix when any candidate contains the fix', () => {
    const lines = [
      { attempt: 0, label: 'invariant' as const, passed: 2, scored: 6, containsFix: false },
      { attempt: 0, label: 'compose' as const, passed: 6, scored: 6, containsFix: true },
      { attempt: 1, label: 'compose' as const, passed: 1, scored: 6, containsFix: false },
    ];
    expect([...trueFixAttempts(lines)]).toEqual([0]);
  });

  it('does not count a candidate as a true fix from a ratio alone, below five passes', () => {
    const lines = [
      { attempt: 0, label: 'compose' as const, passed: 1, scored: 1, containsFix: true },
      { attempt: 1, label: 'compose' as const, passed: 4, scored: 4, containsFix: true },
      { attempt: 2, label: 'compose' as const, passed: 5, scored: 6, containsFix: true },
    ];
    expect([...trueFixAttempts(lines)]).toEqual([2]);
  });

  it('counts the confirmation bar as held only at five passes or more, and missed with no confirmations', () => {
    const confirm = (confirmations: { passed: number; scored: number }[]) => bars({ ...passing, confirmations: confirmations.map((count) => ({ attempt: 0, caseId: 'page-count', ...count })) })[3];
    expect(confirm([])).toMatchObject({ passed: 0, total: 0, met: false });
    expect(confirm([{ passed: 4, scored: 4 }])).toMatchObject({ passed: 0, total: 1, met: false });
    expect(confirm([{ passed: 5, scored: 6 }])).toMatchObject({ passed: 1, total: 1, met: true });
    expect(confirm([{ passed: 5, scored: 6 }, { passed: 1, scored: 1 }])).toMatchObject({ passed: 1, total: 2, met: false });
  });

  it('renders accepted counts, bars, pass^3 per case and probe counts per arm', () => {
    const rows = [...passing.rows, row('D', 5, true, { 'add-months': 1, 'page-count': null })];
    const counts = { 'A-D': { ...emptyCounts(), planned: 30, cached: 30 }, N: emptyCounts(), P: emptyCounts() };
    const text = renderReport({ ...passing, rows }, counts);
    expect(text).toContain('| D | 4/6 | 3/5 |');
    expect(text).toContain('| Arm D accepts at least 3/5 recorded true fixes | 3/5 | met |');
    expect(text).toContain('| D | 1.00 | n/a |');
    expect(text).toContain('| A-D | 30 | 0 | 30 | 0 |');
  });
});
