import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyProposal } from './apply';
import { appendAudit, readAudit } from './audit';
import { addToCorpus, type CorpusCase } from './corpus';
import { guardCorpus } from './corpusGuard';
import { currentRevision, readAgentHarness } from './revisions';
import type { Harness, ImproveResult, ProbeRun } from './types';

let dir: string;

const summary = { runs: 3, excluded: 0, passRate: 0, noise: 0, tokensPerRun: 10 };
const proposal = (harness: Harness): ImproveResult => ({ outcome: 'proposal', reason: 'Gate passed.', harness, base: summary, stages: [], spend: { tokens: 0 } });
const run = (passed: boolean | null): ProbeRun => ({ passed, transcript: '', tokens: 5, ended: 'final' });
const item = (id: string, baseline = { passed: 6, scored: 6 }): CorpusCase => ({ id, traceId: `t-${id}`, input: id, addedAt: '2026-11-01T00:00:00Z', revision: 'a'.repeat(64), origin: 'protected', baseline });

type Script = (harness: Harness, caseId: string, repeat: number) => boolean | null;

const probeOf = (script: Script) => {
  const calls: { caseId: string; repeat: number }[] = [];
  const probe = async (harness: Harness, caseId: string, repeat: number): Promise<ProbeRun> => {
    calls.push({ caseId, repeat });
    return run(script(harness, caseId, repeat));
  };
  return { probe, calls };
};

async function apply(instructions: string): Promise<{ from: string; to: string }> {
  const base = readAgentHarness(dir);
  return applyProposal(dir, { result: proposal({ ...base, instructions }), base }, { mode: 'auto', by: 'gate' });
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'lousho-guard-'));
  writeFileSync(path.join(dir, 'instructions.md'), 'Be careful.\n');
  await addToCorpus(dir, [item('a'), item('b')], 30);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('guardCorpus', () => {
  it('all held passes and audits guard-pass', async () => {
    const { probe, calls } = probeOf(() => true);
    const result = await guardCorpus(dir, { probe, runs: 3, rollback: true });
    expect(result).toMatchObject({ passed: true, runs: 6, tokens: 30, revision: currentRevision(dir) });
    expect(result.cases.map((c) => c.class)).toEqual(['unchanged', 'unchanged']);
    expect(calls.every((call) => call.repeat >= 200)).toBe(true);
    expect(readAudit(dir).at(-1)).toMatchObject({ action: 'guard-pass', actor: 'guard', to: currentRevision(dir), reason: expect.stringMatching(/6 runs/) });
  });

  it('one pooled regression rolls back to the last guard-pass revision', async () => {
    const good = await apply('Good.');
    const { probe: passing } = probeOf(() => true);
    await guardCorpus(dir, { probe: passing, runs: 3, rollback: true });
    await apply('Bad.');
    const { probe } = probeOf((harness, caseId) => !(harness.instructions.startsWith('Bad') && caseId === 'a'));
    const result = await guardCorpus(dir, { probe, runs: 3, rollback: true });
    expect(result).toMatchObject({ passed: false, rolledBackTo: good.to, runs: 15 });
    expect(result.cases.find((c) => c.caseId === 'a')).toMatchObject({ class: 'regressed', final: { passed: 0, scored: 6 } });
    expect(readFileSync(path.join(dir, 'instructions.md'), 'utf8')).toBe('Good.\n');
    expect(readAudit(dir).slice(-2).map((entry) => [entry.action, entry.actor])).toEqual([
      ['guard-fail', 'guard'],
      ['rollback', 'guard'],
    ]);
  });

  it('a single noisy drop that recovers on rerun passes', async () => {
    const { probe } = probeOf((_harness, caseId, repeat) => !(caseId === 'a' && repeat === 200));
    const result = await guardCorpus(dir, { probe, runs: 3, rollback: true });
    expect(result.passed).toBe(true);
    expect(result.cases[0]).toMatchObject({ class: 'unchanged', final: { passed: 5, scored: 6 } });
    expect(result.runs).toBe(9);
  });

  it('rollback false only reports', async () => {
    await apply('Bad.');
    const { probe } = probeOf((harness) => !harness.instructions.startsWith('Bad'));
    const result = await guardCorpus(dir, { probe, runs: 3, rollback: false });
    expect(result.passed).toBe(false);
    expect(result.rolledBackTo).toBeUndefined();
    expect(readFileSync(path.join(dir, 'instructions.md'), 'utf8')).toBe('Bad.\n');
    expect(readAudit(dir).at(-1)?.action).toBe('guard-fail');
  });

  it('falls back to the first baseline without a guard pass', async () => {
    const applied = await apply('Bad.');
    const { probe } = probeOf((harness) => !harness.instructions.startsWith('Bad'));
    const result = await guardCorpus(dir, { probe, runs: 3, rollback: true });
    expect(result.rolledBackTo).toBe(applied.from);
  });

  it('does not count a revision whose last guard run failed as good', async () => {
    const first = await apply('First.');
    await appendAudit(dir, { actor: 'guard', action: 'guard-pass', to: first.to, reason: 'Held.' });
    await appendAudit(dir, { actor: 'guard', action: 'guard-fail', to: first.to, reason: 'Broke later.' });
    await apply('Bad.');
    const { probe } = probeOf((harness) => !harness.instructions.startsWith('Bad'));
    const result = await guardCorpus(dir, { probe, runs: 3, rollback: true });
    expect(result.rolledBackTo).toBe(first.from);
  });

  it('marks a case that passes more often than its baseline as improved', async () => {
    await addToCorpus(dir, [item('c', { passed: 3, scored: 6 })], 30);
    const { probe } = probeOf(() => true);
    const result = await guardCorpus(dir, { probe, runs: 3, rollback: true });
    expect(result.cases.find((c) => c.caseId === 'c')?.class).toBe('improved');
  });

  it('does not roll back over a change that landed during the guard', async () => {
    await apply('Bad.');
    let landed = false;
    const probe = async (harness: Harness): Promise<ProbeRun> => {
      if (!landed) {
        landed = true;
        await apply('Fixed by hand meanwhile.');
      }
      return run(!harness.instructions.startsWith('Bad'));
    };
    const result = await guardCorpus(dir, { probe, runs: 3, rollback: true });
    expect(result).toMatchObject({ passed: false, reason: expect.stringMatching(/rollback was refused/) });
    expect(result.rolledBackTo).toBeUndefined();
    expect(readFileSync(path.join(dir, 'instructions.md'), 'utf8')).toBe('Fixed by hand meanwhile.\n');
  });

  it('passes an empty corpus without running anything', async () => {
    rmSync(path.join(dir, '.lousho', 'corpus.json'));
    const { probe, calls } = probeOf(() => true);
    expect(await guardCorpus(dir, { probe, runs: 3, rollback: true })).toMatchObject({ passed: true, runs: 0 });
    expect(calls).toEqual([]);
    expect(readAudit(dir).filter((entry) => entry.action === 'guard-pass')).toEqual([]);
  });

  it('writes no verdict when too few runs could be scored', async () => {
    const { probe } = probeOf(() => null);
    const result = await guardCorpus(dir, { probe, runs: 3, rollback: true });
    expect(result).toMatchObject({ passed: false, reason: expect.stringMatching(/Too few scored runs/) });
    expect(result.cases.map((c) => c.class)).toEqual(['inconclusive', 'inconclusive']);
    expect(readAudit(dir).filter((entry) => entry.action.startsWith('guard'))).toEqual([]);
  });

  it('writes nothing when the probe throws', async () => {
    const probe = async (): Promise<ProbeRun> => {
      throw new Error('budget exceeded');
    };
    await expect(guardCorpus(dir, { probe, runs: 3, rollback: true })).rejects.toThrow(/budget/);
    expect(readAudit(dir).filter((entry) => entry.action.startsWith('guard'))).toEqual([]);
  });

  it('refuses too few runs or a bad first repeat', async () => {
    const { probe } = probeOf(() => true);
    await expect(guardCorpus(dir, { probe, runs: 1, rollback: true })).rejects.toThrow(/runs/);
    await expect(guardCorpus(dir, { probe, runs: 3, firstRepeat: -1, rollback: true })).rejects.toThrow(/firstRepeat/);
  });

  it('says so when there is no earlier good revision', async () => {
    const { probe } = probeOf(() => false);
    const result = await guardCorpus(dir, { probe, runs: 3, rollback: true });
    expect(result).toMatchObject({ passed: false, reason: expect.stringMatching(/no earlier good revision/) });
  });

  it('compares a dropped case with fresh runs of the harness it was admitted under', async () => {
    const applied = await apply('Better.');
    await addToCorpus(dir, [{ ...item('c', { passed: 6, scored: 6 }), traceId: 't-c2', id: 'c', revision: applied.from }], 30);
    const { probe, calls } = probeOf((harness, caseId) => caseId !== 'c' || harness.instructions === 'Be careful.');
    const result = await guardCorpus(dir, { probe, runs: 3, rollback: false });
    expect(result.cases.find((c) => c.caseId === 'c')).toMatchObject({ class: 'regressed', base: { passed: 6, scored: 6 }, final: { passed: 0, scored: 6 } });
    expect(calls.filter((call) => call.caseId === 'c')).toHaveLength(12);
  });
});

