import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScorePoint } from '../observe/continuousScore';
import type { IngestEvent } from '../observe/envelope';
import { ingestBatch, openDb } from '../observe/store';
import type { SqlDatabase } from '../storage/sqlite/driver';
import { applyProposal } from './apply';
import { readAudit, verifyAudit } from './audit';
import { checkApplied, judgeApplied } from './monitor';
import { loadImproveSettings, type ImproveSettings } from './settings';
import { currentRevision, readAgentHarness } from './revisions';
import type { Harness, ImproveResult } from './types';

const DAY = 86_400_000;
let dir: string;
let db: SqlDatabase;
let traces = 0;

const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};

const summary = { runs: 3, excluded: 0, passRate: 0, noise: 0, tokensPerRun: 10 };
const proposal = (harness: Harness): ImproveResult => ({ outcome: 'proposal', reason: 'Gate passed.', harness, base: summary, stages: [], spend: { tokens: 0 } });

async function apply(): Promise<{ from: string; to: string; at: number }> {
  const base = readAgentHarness(dir);
  const applied = await applyProposal(dir, { result: proposal({ ...base, instructions: 'Be careful. Check the receipt first.' }), base }, { mode: 'auto', by: 'gate' });
  const at = Date.parse(readAudit(dir).at(-1)!.at);
  return { ...applied, at };
}

function runs(revision: string, outcomes: readonly number[], start: number): void {
  ingestBatch(
    db,
    outcomes.flatMap((value, i): IngestEvent[] => {
      const trace = `t${traces++}`;
      return [
        { type: 'observation', data: { obs_id: `root-${trace}`, trace_id: trace, agent_id: 'support', kind: 'span', name: 'invoke_agent support', start: start + i * 1000, end: start + i * 1000 + 10, status: 'ok', attrs: { 'lousho.run.finish_reason': 'stop', 'lousho.harness.revision': revision } } },
        { type: 'score', data: { score_id: `s-${trace}`, trace_id: trace, name: 'check', value, source: 'online', agent_id: 'support', ts: start + i * 1000 + 20 } },
      ];
    })
  );
}

const rate = (passed: number, total: number): number[] => Array.from({ length: total }, (_, i) => (i < passed ? 1 : 0));
const MONITOR_DEFAULTS: ImproveSettings['monitor'] = { minRuns: 20, window: 20, maxDrop: 0.05, autoRollback: true, giveUpDays: 7 };
const settingsWith = (change: Partial<ImproveSettings['monitor']>): ImproveSettings['monitor'] => ({ ...MONITOR_DEFAULTS, ...change });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lousho-monitor-'));
  write('instructions.md', 'Be careful.\n');
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('checkApplied', () => {
  it('pending below minRuns', async () => {
    const applied = await apply();
    runs(applied.from, rate(18, 20), applied.at - 100_000);
    runs(applied.to, rate(5, 19), applied.at + 1000);

    expect(await checkApplied(db, dir, MONITOR_DEFAULTS, { now: applied.at + DAY })).toEqual({ state: 'pending', runs: 19, baselineRuns: 20 });
    expect(readAudit(dir).map((entry) => entry.action)).toEqual(['apply']);
  });

  it('kept when the pass rate holds, audited as a guard pass', async () => {
    const applied = await apply();
    runs(applied.from, rate(16, 20), applied.at - 100_000);
    runs(applied.to, rate(17, 20), applied.at + 1000);

    const verdict = await checkApplied(db, dir, MONITOR_DEFAULTS, { now: applied.at + DAY });
    expect(verdict).toMatchObject({ state: 'kept', before: { runs: 20, passRate: 0.8 }, after: { runs: 20, passRate: 0.85 } });
    expect(readAudit(dir).at(-1)).toMatchObject({ actor: 'monitor', action: 'guard-pass', from: applied.from, to: applied.to, evidence: { score: { before: 0.8, after: 0.85, runs: 20 } } });
    expect(currentRevision(dir)).toBe(applied.to);
  });

  it('rolls back on a 30-point drop with 20 runs each', async () => {
    const applied = await apply();
    runs(applied.from, rate(18, 20), applied.at - 100_000);
    runs(applied.to, rate(12, 20), applied.at + 1000);

    const verdict = await checkApplied(db, dir, MONITOR_DEFAULTS, { now: applied.at + DAY });
    expect(verdict).toMatchObject({ state: 'rolled-back', to: applied.from, reason: 'The pass rate fell from 90% to 60% over 20 runs.' });
    expect(currentRevision(dir)).toBe(applied.from);
    expect(readFileSync(path.join(dir, 'instructions.md'), 'utf8')).toBe('Be careful.\n');
    expect(readAudit(dir).map((entry) => [entry.actor, entry.action])).toEqual([
      ['gate', 'apply'],
      ['monitor', 'rollback'],
      ['monitor', 'retire'],
    ]);
    expect(verifyAudit(dir)).toBeUndefined();
  });

  it('does not roll back a 5-point dip within noise', async () => {
    const applied = await apply();
    runs(applied.from, rate(17, 20), applied.at - 100_000);
    runs(applied.to, rate(16, 20), applied.at + 1000);

    expect(await checkApplied(db, dir, MONITOR_DEFAULTS, { now: applied.at + DAY })).toMatchObject({ state: 'kept' });
    expect(currentRevision(dir)).toBe(applied.to);
  });

  it('waits for another look when a drop is not yet significant, then keeps it at the third', async () => {
    const applied = await apply();
    const before = [...rate(17, 20), ...rate(17, 20), ...rate(17, 20)];
    runs(applied.from, before, applied.at - 100_000);
    runs(applied.to, [...rate(14, 20), ...rate(16, 20), ...rate(16, 20)], applied.at + 1000);

    expect(judgeApplied(points(before), points(rate(14, 20)), MONITOR_DEFAULTS)).toEqual({ verdict: 'wait' });
    expect(await checkApplied(db, dir, MONITOR_DEFAULTS, { now: applied.at + DAY })).toMatchObject({ state: 'kept', after: { runs: 60 } });
  });

  it('does not touch a hand-edited directory', async () => {
    const applied = await apply();
    runs(applied.from, rate(18, 20), applied.at - 100_000);
    runs(applied.to, rate(6, 20), applied.at + 1000);
    write('instructions.md', 'Edited by a person.\n');

    expect(await checkApplied(db, dir, MONITOR_DEFAULTS, { now: applied.at + DAY })).toEqual({ state: 'idle', reason: 'The directory changed by hand after the last apply, so the monitor leaves it alone.' });
    expect(readFileSync(path.join(dir, 'instructions.md'), 'utf8')).toBe('Edited by a person.\n');
    expect(readAudit(dir).map((entry) => entry.action)).toEqual(['apply']);
  });

  it('the M4 defaults from improve.json are the ones these tests use', () => {
    expect(loadImproveSettings(dir, {}, {}).monitor).toEqual(MONITOR_DEFAULTS);
  });

  it('is idle with nothing applied', async () => {
    expect(await checkApplied(db, dir, MONITOR_DEFAULTS)).toEqual({ state: 'idle', reason: 'No applied revision to watch.' });
  });

  it('autoRollback false only reports', async () => {
    const applied = await apply();
    runs(applied.from, rate(18, 20), applied.at - 100_000);
    runs(applied.to, rate(12, 20), applied.at + 1000);

    const verdict = await checkApplied(db, dir, settingsWith({ autoRollback: false }), { now: applied.at + DAY });
    expect(verdict).toMatchObject({ state: 'regressed', reason: 'The pass rate fell from 90% to 60% over 20 runs.' });
    expect(currentRevision(dir)).toBe(applied.to);
    expect(readAudit(dir).at(-1)).toMatchObject({ actor: 'monitor', action: 'guard-fail', reason: 'The pass rate fell from 90% to 60% over 20 runs. Automatic rollback is off.' });
  });

  it('rollback writes a cooldown', async () => {
    const applied = await apply();
    runs(applied.from, rate(18, 20), applied.at - 100_000);
    runs(applied.to, rate(12, 20), applied.at + 1000);
    const now = applied.at + DAY;

    await checkApplied(db, dir, MONITOR_DEFAULTS, { now, cooldownHours: 24 });
    const state = JSON.parse(readFileSync(path.join(dir, '.lousho', 'state.json'), 'utf8')) as { cooldownUntil: string; monitor: { revision: string; verdict: { state: string } } };
    expect(state.cooldownUntil).toBe(new Date(now + DAY).toISOString());
    expect(state.monitor).toMatchObject({ revision: applied.to, verdict: { state: 'rolled-back' } });
  });

  it('a mean score that falls without crossing 0.5 is caught by the trajectory gate', async () => {
    const applied = await apply();
    runs(applied.from, Array.from({ length: 20 }, () => 0.95), applied.at - 100_000);
    runs(applied.to, Array.from({ length: 20 }, () => 0.7), applied.at + 1000);

    expect(await checkApplied(db, dir, MONITOR_DEFAULTS, { now: applied.at + DAY })).toMatchObject({ state: 'rolled-back', reason: 'The mean score fell from 0.95 to 0.70 over 20 runs.' });
  });

  it('keeps a revision unverified after giveUpDays without enough runs, audited once and never rolled back', async () => {
    const applied = await apply();
    runs(applied.to, rate(0, 5), applied.at + 1000);

    expect(await checkApplied(db, dir, MONITOR_DEFAULTS, { now: applied.at + 6 * DAY })).toMatchObject({ state: 'pending', runs: 5 });
    expect(await checkApplied(db, dir, MONITOR_DEFAULTS, { now: applied.at + 7 * DAY })).toEqual({ state: 'kept-unverified', runs: 5 });
    expect(await checkApplied(db, dir, MONITOR_DEFAULTS, { now: applied.at + 8 * DAY })).toEqual({ state: 'kept-unverified', runs: 5 });
    expect(readAudit(dir).filter((entry) => entry.action === 'unverified')).toHaveLength(1);
    expect(currentRevision(dir)).toBe(applied.to);
  });

  it('a decided verdict is not judged or audited again', async () => {
    const applied = await apply();
    runs(applied.from, rate(16, 20), applied.at - 100_000);
    runs(applied.to, rate(17, 20), applied.at + 1000);
    await checkApplied(db, dir, MONITOR_DEFAULTS, { now: applied.at + DAY });
    runs(applied.to, rate(0, 40), applied.at + 100_000);

    expect(await checkApplied(db, dir, MONITOR_DEFAULTS, { now: applied.at + 2 * DAY })).toMatchObject({ state: 'kept' });
    expect(readAudit(dir).filter((entry) => entry.actor === 'monitor')).toHaveLength(1);
  });

  it('after a rollback there is nothing left to watch', async () => {
    const applied = await apply();
    runs(applied.from, rate(18, 20), applied.at - 100_000);
    runs(applied.to, rate(12, 20), applied.at + 1000);
    await checkApplied(db, dir, MONITOR_DEFAULTS, { now: applied.at + DAY });

    expect(await checkApplied(db, dir, MONITOR_DEFAULTS, { now: applied.at + 2 * DAY })).toEqual({ state: 'idle', reason: 'No applied revision to watch.' });
    expect(existsSync(path.join(dir, '.lousho', 'state.json'))).toBe(true);
  });
});

function points(values: readonly number[]): ScorePoint[] {
  return values.map((value, i) => ({ traceId: `p${i}`, at: i, value }));
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function rolledBack(random: () => number, before: number, after: number): boolean {
  const draw = (rate: number, count: number) => points(Array.from({ length: count }, () => (random() < rate ? 1 : 0)));
  const earlier = draw(before, 60);
  const later = draw(after, 60);
  for (const runs of [20, 40, 60]) {
    const judged = judgeApplied(earlier, later.slice(0, runs), MONITOR_DEFAULTS);
    if (judged.verdict !== 'wait') return judged.verdict === 'regressed';
  }
  return false;
}

describe('judgeApplied over 1,000 seeded draws', () => {
  it('false rollback is at most 5% on a stable 0.8 pass rate', () => {
    const random = seeded(42);
    const rollbacks = Array.from({ length: 1000 }, () => rolledBack(random, 0.8, 0.8)).filter(Boolean).length;
    expect(rollbacks / 1000).toBeLessThanOrEqual(0.05);
  });

  it('detection is at least 90% for a true drop from 0.9 to 0.6', () => {
    const random = seeded(7);
    const rollbacks = Array.from({ length: 1000 }, () => rolledBack(random, 0.9, 0.6)).filter(Boolean).length;
    expect(rollbacks / 1000).toBeGreaterThanOrEqual(0.9);
  });
});
