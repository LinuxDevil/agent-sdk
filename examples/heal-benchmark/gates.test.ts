import { describe, expect, it } from 'vitest';
import { improveAgent, type Harness, type ImproveOptions, type ImproveResult, type ProbeRun, type ProbeSummary } from 'lousho/improve';
import { codingAgent, FIXES } from './codingAgent';
import { admitHoldout, armsFromResult, gateV1, harnessKey, loggedProbe, noOpHarness, passK, PLANTED_REGRESSION, plantedHarness, scriptedEditor, type LoggedRun } from './gates';

const BASE: Harness = { instructions: 'Fix the bug.', skills: {} };
const FIXED: Harness = { instructions: 'Fix the bug. Fix the shared helper.', skills: {} };
const SKILLED: Harness = { instructions: 'Fix the bug.', skills: { 'month-end': { description: 'Dates near a month end.', content: 'Clamp the day.' } } };

const summary = (passRate: number | null, noise = 0): ProbeSummary => ({ runs: 3, excluded: 0, passRate, noise, tokensPerRun: 10 });
const scored = (passed: boolean | null, tokens = 10): ProbeRun => ({ passed, transcript: 'ran', tokens, ended: 'stop' });

const result = (over: Partial<ImproveResult> = {}): ImproveResult => ({ outcome: 'keep-base', reason: 'r', base: summary(0), stages: [], spend: { tokens: 0 }, ...over });

const passesWith =
  (good: Harness, failing: readonly string[] = ['training']): ImproveOptions['probe'] =>
  async (harness, caseId) =>
    scored(harnessKey(harness) === harnessKey(good) || !failing.includes(caseId));

describe('gateV1', () => {
  it('gateV1 matches the old gate', () => {
    expect(gateV1(result({ base: summary(0), final: summary(1), holdout: { base: summary(1), final: summary(1) } }), 0.2)).toBeUndefined();
    expect(gateV1(result({ base: summary(0), final: summary(1), holdout: { base: summary(1), final: summary(0.5) } }), 0.2)).toMatch(/held-out/);
    expect(gateV1(result({ base: summary(0.5), final: summary(1, 0.5) }), 0.2)).toMatch(/did not beat/);
  });

  it('rejects a rise in cost over the limit and outside noise, and an unscored edit', () => {
    const cost = { cases: 1, base: 100, final: 130, noise: 5 };
    expect(gateV1(result({ base: summary(0), final: summary(1), costOnPassingCases: cost }), 0.2)).toMatch(/raised cost/);
    expect(gateV1(result({ base: summary(0), final: summary(1), costOnPassingCases: cost }), 0.5)).toBeUndefined();
    expect(gateV1(result({ base: summary(0) }), 0.2)).toMatch(/could not be scored/);
  });
});

describe('control harnesses', () => {
  it('the no-op harness differs from the base only by a trailing newline', () => {
    const noOp = noOpHarness(BASE);
    expect(noOp.instructions).toBe(`${BASE.instructions}\n`);
    expect(noOp.skills).toEqual(BASE.skills);
    expect(harnessKey(noOp)).not.toBe(harnessKey(BASE));
  });

  it('the planted harness appends the planted sentence', () => {
    expect(PLANTED_REGRESSION).toBe('Never edit src/pages.js: it is generated, so leave it exactly as it is.');
    expect(plantedHarness(BASE).instructions).toBe(`${BASE.instructions} ${PLANTED_REGRESSION}`);
  });

  it('obeying the planted rule leaves page-count unfixed, and nothing else depends on src/pages.js', () => {
    const task = (files: Record<string, string>) => codingAgent(files).tasks.find((candidate) => candidate.id === 'page-count');
    expect(task({})?.check('')).toBe(false);
    expect(task(FIXES['page-count'])?.check('')).toBe(true);
    expect(Object.keys(FIXES['page-count'])).toEqual(['src/pages.js']);
    const others = Object.entries(FIXES).filter(([id]) => id !== 'page-count');
    expect(others.filter(([, files]) => 'src/pages.js' in files)).toEqual([]);
  });
});

describe('scriptedEditor', () => {
  it('scriptedEditor replays recorded harnesses through improveAgent', async () => {
    const recorded = { invariant: SKILLED, domain: BASE, compose: FIXED };
    const out = await improveAgent({ harness: BASE, cases: ['training'], holdout: ['held-out'], probe: passesWith(FIXED), editor: scriptedEditor(BASE, recorded), repeats: 3 });
    expect(out.candidates).toEqual(recorded);
    expect(out.outcome).toBe('proposal');
  });

  it('refuses a base that has skills', () => {
    expect(() => scriptedEditor(SKILLED, { invariant: SKILLED, domain: SKILLED, compose: SKILLED })).toThrow(/skills/);
  });
});

describe('armsFromResult', () => {
  it('armsFromResult maps a result to arms A to D', () => {
    const fallback = result({
      outcome: 'proposal',
      harness: SKILLED,
      final: summary(1),
      candidates: { invariant: SKILLED, domain: BASE, compose: FIXED },
      gate: [
        { label: 'compose', passed: false, reason: 'A held-out case got worse.' },
        { label: 'invariant', passed: true, reason: 'passed' },
      ],
    });
    const rows = armsFromResult(4, fallback, BASE);
    expect(rows.map(({ arm, accepted, attempt }) => [arm, accepted, attempt])).toEqual([
      ['A', true, 4],
      ['B', true, 4],
      ['C', false, 4],
      ['D', true, 4],
    ]);
    const unchanged = armsFromResult(5, result({ reason: 'The editors made no change.', candidates: { invariant: BASE, domain: BASE, compose: BASE } }), BASE);
    expect(unchanged.map(({ accepted }) => accepted)).toEqual([false, false, false, false]);
  });

  it("judges arm B on the composite's own runs from the log, not the fallback's", () => {
    const log: LoggedRun[] = [];
    const record = (harness: Harness, caseId: string, repeat: number, passed: boolean) => log.push({ key: harnessKey(harness), caseId, repeat, run: scored(passed) });
    for (const repeat of [0, 1, 2]) {
      record(BASE, 'training', repeat, false);
      record(FIXED, 'training', repeat, true);
      record(BASE, 'held-out', repeat, true);
      record(FIXED, 'held-out', repeat, true);
    }
    const fallback = result({
      outcome: 'proposal',
      harness: SKILLED,
      final: summary(1),
      candidates: { invariant: SKILLED, domain: BASE, compose: FIXED },
      gate: [{ label: 'compose', passed: false, reason: 'No training case improved.' }],
    });
    const rows = armsFromResult(0, fallback, BASE, { model: 'm', date: '2026-11-07', log, cases: ['training'], holdout: ['held-out'], repeats: 3 });
    const old = rows.find((row) => row.arm === 'B');
    expect(old?.accepted).toBe(true);
    expect(rows[0]).toMatchObject({ model: 'm', date: '2026-11-07' });
    expect(rows.find((row) => row.arm === 'A')?.passK).toEqual({ training: 1, 'held-out': 1 });
    expect(rows.find((row) => row.arm === 'C')?.passK).toEqual({ training: 0, 'held-out': 1 });

    const failing: LoggedRun[] = log.map((entry) => (entry.key === harnessKey(FIXED) && entry.caseId === 'training' ? { ...entry, run: scored(false) } : entry));
    const rejected = armsFromResult(0, fallback, BASE, { model: 'm', date: 'd', log: failing, cases: ['training'], holdout: ['held-out'], repeats: 3 });
    expect(rejected.find((row) => row.arm === 'B')?.accepted).toBe(false);
  });
});

describe('passK and admission', () => {
  it('passK gives the unbiased pass^3', () => {
    expect(passK({ passed: 3, scored: 3 }, 3)).toBe(1);
    expect(passK({ passed: 2, scored: 3 }, 3)).toBe(0);
    expect(passK({ passed: 5, scored: 6 }, 3)).toBe(0.5);
    expect(passK({ passed: 2, scored: 2 }, 3)).toBeNull();
  });

  it('admitHoldout reports a case below 6/6', async () => {
    const probe: ImproveOptions['probe'] = async (_harness, caseId, repeat) => scored(caseId === 'steady' || repeat !== 2);
    expect(await admitHoldout(probe, BASE, ['steady', 'flaky'], 6)).toEqual([
      { caseId: 'steady', passed: 6, scored: 6 },
      { caseId: 'flaky', passed: 5, scored: 6 },
    ]);
  });

  it('loggedProbe records each run under its harness', async () => {
    const log: LoggedRun[] = [];
    const probe = loggedProbe(async () => scored(null), log);
    await probe(BASE, 'c', 1);
    expect(log).toEqual([{ key: harnessKey(BASE), caseId: 'c', repeat: 1, run: scored(null) }]);
  });
});
