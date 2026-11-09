import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../execution/errors';
import { readAudit } from './audit';
import { openDb } from '../observe/store';
import { approvePending } from './approvePending';
import { canaryArm, routesToCandidate } from './canaryArm';
import { listPending, readPendingProposal, rejectPending, savePending } from './pending';
import { readCanary } from './trafficCanary';
import { harnessHash, readAgentHarness } from './revisions';
import type { Harness, ImproveResult } from './types';

let dir: string;

const summary = { runs: 3, excluded: 0, passRate: 0, noise: 0, tokensPerRun: 10 };
const proposal = (harness: Harness): ImproveResult => ({ outcome: 'proposal', reason: 'Gate passed.', harness, base: summary, stages: [], spend: { tokens: 0 } });
const read = (file: string): string => readFileSync(path.join(dir, file), 'utf8');

async function queue(instructions = 'Be very careful.') {
  const base = readAgentHarness(dir);
  return savePending(dir, { result: proposal({ ...base, instructions }), base, card: 'card text', cycle: 'c1' });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lousho-pending-'));
  writeFileSync(path.join(dir, 'instructions.md'), 'Be careful.\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('pending proposals', () => {
  it('saves a proposal under its hash prefix and audits propose', async () => {
    const pending = await queue();
    expect(pending.id).toBe(harnessHash({ instructions: 'Be very careful.', skills: {} }).slice(0, 12));
    expect(existsSync(path.join(dir, '.lousho', 'proposals', `${pending.id}.json`))).toBe(true);
    expect(listPending(dir).map((item) => item.id)).toEqual([pending.id]);
    expect(readAudit(dir)).toEqual([expect.objectContaining({ action: 'propose', actor: 'gate', cycle: 'c1', to: harnessHash({ instructions: 'Be very careful.', skills: {} }) })]);
    expect(read('instructions.md')).toBe('Be careful.\n');
  });

  it('refuses to queue a result that is not a proposal', async () => {
    const base = readAgentHarness(dir);
    await expect(savePending(dir, { result: { ...proposal(base), outcome: 'keep-base' }, base, card: '' })).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('approve applies and removes the pending file', async () => {
    const pending = await queue();
    const applied = await approvePending(dir, pending.id, 'ali');
    expect('to' in applied && applied.to).toBeTruthy();
    expect(read('instructions.md')).toBe('Be very careful.\n');
    expect(listPending(dir)).toEqual([]);
    expect(readAudit(dir).at(-1)).toMatchObject({ action: 'apply', actor: 'person:ali', to: 'to' in applied ? applied.to : '', cycle: 'c1' });
  });

  it('manual with canary.traffic: no session routes to the candidate before approve, and approve starts the canary in the person\'s name', async () => {
    writeFileSync(path.join(dir, 'improve.json'), JSON.stringify({ approval: 'manual', canary: { traffic: { share: 0.25, sessions: 10 } } }));
    const ids = Array.from({ length: 400 }, (_, i) => `s${i}`).filter((id) => routesToCandidate(id, 0.25));
    const arm = canaryArm(dir, { instructions: 'Be careful.', skills: [] });
    const pending = await queue();
    expect(ids.some((id) => arm({ sessionId: id }) !== undefined)).toBe(false);
    await expect(approvePending(dir, pending.id, 'ali')).rejects.toThrow(/observe database/);
    expect(ids.some((id) => arm({ sessionId: id }) !== undefined)).toBe(false);
    const db = openDb(':memory:');
    try {
      const approved = await approvePending(dir, pending.id, 'ali', { db });
      expect('canary' in approved && approved.canary).toMatchObject({ approvedBy: 'ali', revision: harnessHash({ instructions: 'Be very careful.', skills: {} }) });
    } finally {
      db.close();
    }
    expect(read('instructions.md')).toBe('Be careful.\n');
    expect(listPending(dir)).toEqual([]);
    expect(readCanary(dir)).toMatchObject({ approvedBy: 'ali' });
    expect(readAudit(dir).at(-1)).toMatchObject({ action: 'canary-start', actor: 'person:ali' });
    expect(arm({ sessionId: ids[0] })).toMatchObject({ instructions: 'Be very careful.' });
  });

  it('approve of a stale proposal is refused and marks it stale', async () => {
    const pending = await queue();
    writeFileSync(path.join(dir, 'instructions.md'), 'Edited by a person.\n');
    await expect(approvePending(dir, pending.id, 'ali')).rejects.toThrow(/stale/);
    expect(read('instructions.md')).toBe('Edited by a person.\n');
    expect(listPending(dir)[0]).toMatchObject({ id: pending.id, staleAt: expect.any(String) });
    expect(readAudit(dir).at(-1)).toMatchObject({ action: 'stale', actor: 'person:ali' });
  });

  it('reject moves the file and audits the reason', async () => {
    const pending = await queue();
    await rejectPending(dir, pending.id, 'ali', 'Too broad.');
    expect(listPending(dir)).toEqual([]);
    expect(existsSync(path.join(dir, '.lousho', 'proposals', 'rejected', `${pending.id}.json`))).toBe(true);
    expect(readAudit(dir).at(-1)).toMatchObject({ action: 'reject', actor: 'person:ali', reason: `Rejected ${pending.id}: Too broad.` });
    expect(read('instructions.md')).toBe('Be careful.\n');
  });

  it('refuses ids that are not a pending proposal, including path tricks', async () => {
    await expect(approvePending(dir, '../../etc/passwd', 'ali')).rejects.toThrow(/not a pending proposal id/);
    await expect(approvePending(dir, 'aaaaaaaaaaaa', 'ali')).rejects.toThrow(/No pending proposal/);
    await expect(rejectPending(dir, 'zz', 'ali', 'r')).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('needs a name to approve or reject', async () => {
    const pending = await queue();
    await expect(approvePending(dir, pending.id, ' ')).rejects.toBeInstanceOf(ConfigurationError);
    await expect(rejectPending(dir, pending.id, '', 'r')).rejects.toBeInstanceOf(ConfigurationError);
    expect(listPending(dir)).toHaveLength(1);
  });

  it('lists newest first and skips unreadable files', async () => {
    const first = await queue('First.');
    const second = await queue('Second.');
    writeFileSync(path.join(dir, '.lousho', 'proposals', 'ffffffffffff.json'), '{');
    expect(listPending(dir).map((item) => item.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('leaves out a file whose content does not match its id', async () => {
    const pending = await queue();
    const file = path.join(dir, '.lousho', 'proposals', `${pending.id}.json`);
    const forged = JSON.parse(readFileSync(file, 'utf8')) as { result: { harness: Harness } };
    forged.result.harness.instructions = 'Something the gate never saw.';
    writeFileSync(file, JSON.stringify(forged));
    expect(listPending(dir)).toEqual([]);
    await expect(approvePending(dir, pending.id, 'ali')).rejects.toThrow(/doesn't match its id/);
    expect(read('instructions.md')).toBe('Be careful.\n');
  });

  it('leaves out a file without a creation time instead of failing the list', async () => {
    const pending = await queue();
    const file = path.join(dir, '.lousho', 'proposals', `${pending.id}.json`);
    const broken = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete broken.createdAt;
    writeFileSync(file, JSON.stringify(broken));
    await queue('Another.');
    expect(listPending(dir)).toHaveLength(1);
  });

  it('refuses a symlinked proposals folder', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'lousho-pending-outside-'));
    mkdirSync(path.join(dir, '.lousho'));
    symlinkSync(outside, path.join(dir, '.lousho', 'proposals'));
    await expect(queue()).rejects.toThrow(/symlink/);
    expect(() => listPending(dir)).toThrow(/symlink/);
    rmSync(outside, { recursive: true, force: true });
  });

  it('never queues a rejected proposal again', async () => {
    const pending = await queue();
    await rejectPending(dir, pending.id, 'ali', 'No.');
    await expect(queue()).rejects.toThrow(/rejected before/);
  });

  it('keeps the gate instructions limit for approval and records the refusal', async () => {
    const base = readAgentHarness(dir);
    const pending = await savePending(dir, { result: proposal({ ...base, instructions: 'x'.repeat(30) }), base, card: 'card', maxAlwaysOnChars: 20 });
    await expect(approvePending(dir, pending.id, 'ali')).rejects.toThrow(/limit/);
    expect(readPendingProposal(dir, pending.id).failure).toMatch(/limit/);
  });
});
