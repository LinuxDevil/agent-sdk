import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../execution/errors';
import { applyProposal, type ApplyInput, type Approval } from './apply';
import type { AuditEntry, AuditInput } from './audit';
import { folderAuditLog, type AuditLog, type HarnessStore } from './harnessStore';
import { skillText } from './harnessWriter';
import { harnessHash, readAgentHarness, type HarnessRevision } from './revisions';
import { applyProposalIn, rollbackHarnessIn } from './storeApply';
import type { Harness, ImproveResult } from './types';

const dirs: string[] = [];

const summary = { runs: 3, excluded: 0, passRate: 0, noise: 0, tokensPerRun: 10 };

const proposal = (harness: Harness, outcome: ImproveResult['outcome'] = 'proposal'): ImproveResult => ({
  outcome,
  reason: 'Training improved on every case.',
  harness,
  base: summary,
  stages: [],
  spend: { tokens: 0 },
});

function tempDir(): string {
  const at = mkdtempSync(path.join(tmpdir(), 'lousho-store-apply-'));
  dirs.push(at);
  return at;
}

function agentDir(): string {
  const at = tempDir();
  mkdirSync(path.join(at, 'skills', 'tone'), { recursive: true });
  writeFileSync(path.join(at, 'instructions.md'), 'Be brief.\n');
  writeFileSync(path.join(at, 'skills', 'tone', 'SKILL.md'), skillText('tone', { description: 'Tone rules.', content: 'Use plain words.' }, undefined));
  return at;
}

function memoryAuditLog(): AuditLog {
  const entries: AuditEntry[] = [];
  return {
    append: async (entry: AuditInput) => {
      const body = { seq: entries.length + 1, at: new Date().toISOString(), ...entry, prev: entries.at(-1)?.hash ?? 'genesis' };
      const written: AuditEntry = { ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
      entries.push(written);
      return written;
    },
    read: async () => [...entries],
    verify: async () => undefined,
  };
}

function memoryHarnessStore(initial: Harness, revisions: HarnessRevision[] = [], readOnly: string[] = []): HarnessStore {
  let current = initial;
  const saved = [...revisions];
  const audit = memoryAuditLog();
  return {
    key: 'memory',
    read: async () => ({ harness: current, readOnly }),
    revisions: async () => [...saved],
    commit: async (next, { action, audit: entry }) => {
      const to = harnessHash(next);
      current = next;
      saved.unshift({ id: to, at: new Date().toISOString(), source: action, harness: next });
      const written = ['instructions.md'];
      const reason = action === 'apply' ? `Applied ${written.join(', ')}.` : entry.reason;
      await audit.append({ ...entry, to, reason });
      return { to, written };
    },
    withLock: (task) => task(),
    audit,
  };
}

const failure = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: unknown) => error
  );

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('applyProposalIn', () => {
  it('writes through the store and appends one apply entry', async () => {
    const harness: Harness = { instructions: 'Be brief.', skills: { tone: { description: 'Tone rules.', content: 'Use plain words.' } } };
    const store = memoryHarnessStore(harness);
    const next: Harness = { instructions: 'Be very brief.', skills: harness.skills };
    const result = await applyProposalIn(store, { result: proposal(next), base: harness }, { mode: 'manual', approvedBy: 'ali' });
    expect(result.from).toBe(harnessHash(harness));
    expect(result.to).toBe(harnessHash(next));
    expect(result.written).toEqual(['instructions.md']);
    const audit = await store.audit.read();
    expect(audit.map((entry) => entry.action)).toEqual(['apply']);
    expect(audit[0]?.actor).toBe('person:ali');
    expect(audit[0]?.to).toBe(result.to);
    expect(audit[0]?.reason).toBe('Applied instructions.md.');
  });

  it('a stale base is refused with field base and audited as stale', async () => {
    const current: Harness = { instructions: 'Be brief.', skills: { tone: { description: 'Tone rules.', content: 'Use plain words.' } } };
    const base: Harness = { instructions: 'An older brief.', skills: current.skills };
    const store = memoryHarnessStore(current);
    const next: Harness = { instructions: 'Be very brief.', skills: current.skills };
    await expect(applyProposalIn(store, { result: proposal(next), base }, { mode: 'auto', by: 'gate' })).rejects.toMatchObject({ field: 'base' });
    const audit = await store.audit.read();
    expect(audit.at(-1)?.action).toBe('stale');
    expect((await store.read()).harness).toEqual(current);
  });

  it('M4 and the store path refuse the same inputs with the same message', async () => {
    const dir = agentDir();
    const current = readAgentHarness(dir);
    const store = memoryHarnessStore(current);
    const approval: Approval = { mode: 'auto', by: 'gate' };
    const changed: Harness = { instructions: 'Be very brief.', skills: current.skills };
    const cases: { name: string; input: ApplyInput }[] = [
      { name: 'not a proposal', input: { result: proposal(changed, 'keep-base'), base: current } },
      { name: 'stale base', input: { result: proposal(changed), base: { instructions: 'An older brief.', skills: current.skills } } },
      { name: 'changes nothing', input: { result: proposal(current), base: current } },
      { name: 'fails validation', input: { result: proposal({ ...current, instructions: 'x'.repeat(50) }), base: current, maxAlwaysOnChars: 10 } },
    ];
    for (const { name, input } of cases) {
      const dirError = await failure(applyProposal(dir, input, approval));
      const storeError = await failure(applyProposalIn(store, input, approval));
      expect(dirError, name).toBeInstanceOf(ConfigurationError);
      expect(storeError, name).toBeInstanceOf(ConfigurationError);
      expect((storeError as Error).message, name).toBe((dirError as Error).message);
      expect((storeError as ConfigurationError).field, name).toBe((dirError as ConfigurationError).field);
    }
  });
});

describe('rollbackHarnessIn', () => {
  it('restores a saved revision as a new commit', async () => {
    const older: Harness = { instructions: 'Be brief.', skills: { tone: { description: 'Tone rules.', content: 'Use plain words.' } } };
    const newer: Harness = { instructions: 'Be very brief.', skills: older.skills };
    const olderId = harnessHash(older);
    const revisions: HarnessRevision[] = [
      { id: harnessHash(newer), at: '2026-01-02T00:00:00.000Z', source: 'apply', harness: newer },
      { id: olderId, at: '2026-01-01T00:00:00.000Z', source: 'baseline', harness: older },
    ];
    const store = memoryHarnessStore(newer, revisions);
    const result = await rollbackHarnessIn(store, olderId, { actor: 'person:ali', reason: 'undo' });
    expect(result.from).toBe(harnessHash(newer));
    expect(result.to).toBe(olderId);
    expect((await store.read()).harness).toEqual(older);
    const audit = await store.audit.read();
    expect(audit.at(-1)?.action).toBe('rollback');
    expect(audit.at(-1)?.actor).toBe('person:ali');
    expect(audit.at(-1)?.reason).toBe('undo');
  });

  it('a read-only skill cannot be changed through the store', async () => {
    const harness: Harness = { instructions: 'Be brief.', skills: { tone: { description: 'Tone rules.', content: 'Use plain words.' } } };
    const store = memoryHarnessStore(harness, [], ['tone']);
    const next: Harness = { instructions: 'Be brief.', skills: { tone: { description: 'Tone rules.', content: 'Use plain words, always.' } } };
    await expect(applyProposalIn(store, { result: proposal(next), base: harness }, { mode: 'auto', by: 'gate' })).rejects.toThrow(/read-only/);
    const audit = await store.audit.read();
    expect(audit.at(-1)?.action).toBe('reject');
    expect((await store.read()).harness).toEqual(harness);
  });
});

describe('folderAuditLog', () => {
  it('reads and verifies the folder log', async () => {
    const dir = tempDir();
    const log = folderAuditLog(dir);
    await log.append({ actor: 'gate', action: 'apply', from: 'a'.repeat(64), to: 'b'.repeat(64), reason: 'first' });
    await log.append({ actor: 'gate', action: 'rollback', from: 'b'.repeat(64), to: 'a'.repeat(64), reason: 'second' });
    expect(await log.read()).toHaveLength(2);
    expect(await log.verify()).toBeUndefined();
  });
});
