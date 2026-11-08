import { describe, expect, it } from 'vitest';
import type { PilotRow } from './pilot';
import { buildReport, formatReport, latestRows, passHatK, verdict, type ArmSummary } from './score';

const row = (over: Partial<PilotRow> = {}): PilotRow => ({
  arm: 'flat',
  case: 'c1',
  repeat: 0,
  passed: true,
  tokens: 1000,
  costUsd: null,
  modelCalls: 4,
  toolRuns: 3,
  ended: 'stop',
  model: 'm',
  date: '2026-11-08T00:00:00.000Z',
  ...over,
});

const runs = (arm: PilotRow['arm'], caseId: string, passed: boolean[], over: Partial<PilotRow> = {}): PilotRow[] => passed.map((value, repeat) => row({ arm, case: caseId, repeat, passed: value, ...over }));

const summary = (over: Partial<ArmSummary>): ArmSummary => ({ arm: 'flat', cases: 1, passK: 1, passRate: 1, scored: 3, meanTokens: 100, meanCostUsd: null, meanModelCalls: 1, ...over });

describe('passHatK', () => {
  it('is 1 only when all k of k runs pass', () => {
    expect(passHatK(3, 3, 3)).toBe(1);
    expect(passHatK(3, 2, 3)).toBe(0);
    expect(passHatK(3, 0, 3)).toBe(0);
  });

  it('estimates the chance k fresh runs all pass when there are more than k runs', () => {
    expect(passHatK(4, 3, 3)).toBeCloseTo(1 / 4);
    expect(passHatK(6, 4, 3)).toBeCloseTo(4 / 20);
  });

  it('refuses fewer than k runs', () => {
    expect(() => passHatK(2, 2, 3)).toThrow(/at least 3/);
  });
});

describe('latestRows', () => {
  it('keeps the last scored row for a key, and never lets an excluded row replace a scored one', () => {
    const kept = latestRows([row({ passed: false }), row({ passed: true, tokens: 5 }), row({ passed: null, tokens: 9 })]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ passed: true, tokens: 5 });
  });

  it('replaces an excluded row with a later scored one, as a resumed run does', () => {
    expect(latestRows([row({ passed: null }), row({ passed: false })])[0].passed).toBe(false);
  });
});

describe('buildReport', () => {
  it('computes pass^3, pass rate, mean tokens and the token cost ratio per arm', () => {
    const report = buildReport([
      ...runs('flat', 'a', [true, true, true], { tokens: 1000 }),
      ...runs('flat', 'b', [true, false, true], { tokens: 1000 }),
      ...runs('product', 'a', [true, true, true], { tokens: 1200 }),
      ...runs('product', 'b', [true, true, true], { tokens: 1200 }),
    ]);
    const [flat, product] = report.arms;
    expect(flat).toMatchObject({ arm: 'flat', cases: 2, passK: 0.5, scored: 6, meanTokens: 1000 });
    expect(flat.passRate).toBeCloseTo(5 / 6);
    expect(product).toMatchObject({ arm: 'product', passK: 1, passRate: 1, meanTokens: 1200 });
    expect(report.verdict).toMatchObject({ go: true, costBasis: 'tokens' });
    expect(report.verdict.costRatio).toBeCloseTo(1.2);
    expect(report.cases).toEqual([
      { case: 'a', arms: { flat: { passed: 3, scored: 3 }, product: { passed: 3, scored: 3 } } },
      { case: 'b', arms: { flat: { passed: 2, scored: 3 }, product: { passed: 3, scored: 3 } } },
    ]);
  });

  it('says no-go when the product passes less, or costs more than 1.3x', () => {
    const worse = buildReport([...runs('flat', 'a', [true, true, true]), ...runs('product', 'a', [true, true, false])]);
    expect(worse.verdict.go).toBe(false);
    const dearer = buildReport([...runs('flat', 'a', [true, true, true], { tokens: 100 }), ...runs('product', 'a', [true, true, true], { tokens: 131 })]);
    expect(dearer.verdict.go).toBe(false);
    expect(dearer.verdict.reason).toMatch(/1\.31x/);
    const edge = buildReport([...runs('flat', 'a', [true, true, true], { tokens: 100 }), ...runs('product', 'a', [true, true, true], { tokens: 130 })]);
    expect(edge.verdict.go).toBe(true);
  });

  it('uses USD for the ratio when every scored run has a cost, and tokens otherwise', () => {
    const priced = buildReport([...runs('flat', 'a', [true, true, true], { costUsd: 0.01, tokens: 100 }), ...runs('product', 'a', [true, true, true], { costUsd: 0.02, tokens: 100 })]);
    expect(priced.verdict).toMatchObject({ costBasis: 'usd', go: false });
    expect(priced.verdict.costRatio).toBeCloseTo(2);
    const partly = buildReport([...runs('flat', 'a', [true, true, true], { costUsd: 0.01, tokens: 100 }), ...runs('product', 'a', [true, true, true], { tokens: 100 })]);
    expect(partly.verdict).toMatchObject({ costBasis: 'tokens', costRatio: 1, go: true });
  });

  it('leaves out a case that lacks k scored runs in any arm, and ignores excluded rows', () => {
    const report = buildReport([
      ...runs('flat', 'a', [true, true, true]),
      ...runs('product', 'a', [true, true, true]),
      ...runs('flat', 'b', [true, true, true]),
      ...runs('product', 'b', [true, true]),
      row({ arm: 'product', case: 'b', repeat: 2, passed: null }),
    ]);
    expect(report.cases.map((entry) => entry.case)).toEqual(['a']);
    expect(report.incomplete).toEqual(['b']);
    expect(report.arms.every((arm) => arm.scored === 3)).toBe(true);
  });

  it('reports a third arm without letting it change the go/no-go', () => {
    const report = buildReport([...runs('flat', 'a', [true, true, true]), ...runs('product', 'a', [true, true, true]), ...runs('flat-plus', 'a', [false, false, false])]);
    expect(report.arms.map((arm) => arm.arm)).toEqual(['flat', 'flat-plus', 'product']);
    expect(report.verdict.go).toBe(true);
  });

  it('refuses rows from more than one model', () => {
    expect(() => buildReport([row(), row({ model: 'other' })])).toThrow(/mix models/);
  });

  it('gives no decision without both arms', () => {
    expect(buildReport(runs('flat', 'a', [true, true, true])).verdict.go).toBeNull();
    expect(verdict(summary({}), summary({ arm: 'product', meanTokens: null }))).toMatchObject({ go: null });
  });

  it('prints the arms, the cases and the decision', () => {
    const text = formatReport(buildReport([...runs('flat', 'a', [true, true, true]), ...runs('product', 'a', [true, true, true])]));
    expect(text).toMatch(/^flat\s+1\.000/m);
    expect(text).toMatch(/^a\s+flat 3\/3\s+product 3\/3/m);
    expect(text).toMatch(/^GO: product pass\^k 1\.000 >= flat 1\.000; cost 1\.00x flat \(tokens\) <= 1\.3x$/m);
  });
});
