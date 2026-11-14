import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyProposal } from './apply';
import { guardApproval } from './approveGuard';
import { readAudit } from './audit';
import { addToCorpus } from './corpus';
import { usageToday } from './cycles';
import { currentRevision, readAgentHarness } from './revisions';
import type { Harness, ImproveResult, ProbeRun } from './types';

let dir: string;

const summary = { runs: 3, excluded: 0, passRate: 0, noise: 0, tokensPerRun: 10 };
const proposal = (harness: Harness): ImproveResult => ({ outcome: 'proposal', reason: 'Gate passed.', harness, base: summary, stages: [], spend: { tokens: 0 } });
const instructions = () => readFileSync(path.join(dir, 'instructions.md'), 'utf8');

const probeOf =
  (passes: (harness: Harness) => boolean | null) =>
  async (harness: Harness): Promise<ProbeRun> => ({ passed: passes(harness), transcript: '', tokens: 5, ended: 'final' });

async function approveEdit(text = 'Changed.'): Promise<{ from: string; to: string }> {
  const base = readAgentHarness(dir);
  return applyProposal(dir, { result: proposal({ ...base, instructions: text }), base }, { mode: 'manual', approvedBy: 'ali' });
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'lousho-approve-guard-'));
  writeFileSync(path.join(dir, 'instructions.md'), 'Be careful.\n');
  const revision = currentRevision(dir);
  await addToCorpus(dir, [{ id: 'pass:a', traceId: 'a', input: 'a', addedAt: new Date().toISOString(), revision, origin: 'protected', baseline: { passed: 6, scored: 6 } }], 30);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('guardApproval', () => {
  it('keeps an approved edit the corpus guard passes, and counts its tokens toward the day', async () => {
    const applied = await approveEdit();
    const result = await guardApproval(dir, applied, { probe: probeOf(() => true), runs: 3 });
    expect(result).toMatchObject({ passed: true, guard: { passed: true, revision: applied.to } });
    expect(result.rolledBackTo).toBeUndefined();
    expect(instructions()).toBe('Changed.\n');
    expect(readAudit(dir).at(-1)).toMatchObject({ action: 'guard-pass', to: applied.to });
    expect(usageToday(dir, Date.now()).tokens).toBe(15);
  });

  it("rolls back to the approved revision's parent on a regression", async () => {
    const applied = await approveEdit();
    const result = await guardApproval(dir, applied, { probe: probeOf((harness) => !harness.instructions.startsWith('Changed')), runs: 3 });
    expect(result).toMatchObject({ passed: false, rolledBackTo: applied.from, reason: expect.stringMatching(/regressed/) });
    expect(currentRevision(dir)).toBe(applied.from);
    expect(instructions()).toBe('Be careful.\n');
    expect(readAudit(dir).slice(-2)).toMatchObject([{ action: 'guard-fail' }, { action: 'rollback', actor: 'guard', from: applied.to, to: applied.from }]);
  });

  it("rolls back when the guard can't judge or can't run", async () => {
    const unjudged = await approveEdit();
    expect(await guardApproval(dir, unjudged, { probe: probeOf(() => null), runs: 3 })).toMatchObject({ passed: false, rolledBackTo: unjudged.from, reason: expect.stringMatching(/can't judge/) });
    const broken = await approveEdit('Changed again.');
    const failing = async (): Promise<ProbeRun> => {
      throw new Error('disk full');
    };
    expect(await guardApproval(dir, broken, { probe: failing, runs: 3 })).toMatchObject({ passed: false, rolledBackTo: broken.from, reason: expect.stringMatching(/disk full/) });
  });

  it('says so and keeps the edit when the rollback is refused', async () => {
    const applied = await approveEdit();
    const editing = async (): Promise<ProbeRun> => {
      writeFileSync(path.join(dir, 'instructions.md'), 'Hand edit.\n');
      return { passed: null, transcript: '', tokens: 4, ended: 'final' };
    };
    const result = await guardApproval(dir, applied, { probe: editing, runs: 3 });
    expect(result).toMatchObject({ passed: false, reason: expect.stringMatching(/rollback .* was refused/) });
    expect(result.rolledBackTo).toBeUndefined();
    expect(usageToday(dir, Date.now()).tokens).toBe(12);
  });

  it("doesn't guard or roll back when the directory changed after the approval", async () => {
    const applied = await approveEdit();
    writeFileSync(path.join(dir, 'instructions.md'), 'Hand edit.\n');
    let calls = 0;
    const result = await guardApproval(dir, applied, { probe: async () => ({ passed: (calls += 1) > 0, transcript: '', tokens: 5, ended: 'final' }), runs: 3 });
    expect(result).toMatchObject({ passed: false, reason: expect.stringMatching(/changed after the approval/) });
    expect(calls).toBe(0);
    expect(instructions()).toBe('Hand edit.\n');
    expect(readAudit(dir).map((entry) => entry.action)).not.toContain('guard-fail');
  });
});
