import fs from 'node:fs';
import path from 'node:path';
import { ConfigurationError } from '../execution/errors';
import { withFileLock } from '../storage/fileLock';
import { appendAudit, cleanActor, readAudit, type AuditEntry } from './audit';
import { validateHarness } from './harness';
import { recoverInterruptedWrite, refusal, STALE_FIELD, writeHarnessFiles, writtenHash, type HarnessWrite } from './harnessWriter';
import { harnessHash, listRevisions, readHarnessState, snapshotRevision } from './revisions';
import type { Harness, ImproveResult } from './types';

/** Who let a proposal through: the gate in auto mode, or a named person. */
export type Approval =
  | {
      /** Applied without a person. */
      mode: 'auto';
      /** The loop stage that passed it. */
      by: 'gate' | 'canary';
    }
  | {
      /** Applied because a person approved it. */
      mode: 'manual';
      /** The name of the person who approved it. */
      approvedBy: string;
    };

/** A gated proposal and the harness it was made against. */
export interface ApplyInput {
  /** The improvement result; only a `proposal` with a harness can be applied. */
  result: ImproveResult;
  /** The harness the proposal was made against; the directory must still hold it. */
  base: Harness;
  /** The self-healing cycle that made the proposal. */
  cycle?: string;
  /** The instructions length limit the proposal was gated with (default 8000). */
  maxAlwaysOnChars?: number;
}

/** The revisions before and after an apply, and the files it changed, relative to the agent directory. */
export interface ApplyResult {
  /** The revision before the write. */
  from: string;
  /** The revision after the write. */
  to: string;
  /** The files written or removed, such as `instructions.md` and `skills/<name>/SKILL.md`. */
  written: string[];
}

const DEFAULT_MAX_ALWAYS_ON = 8000;

function recordedSince(dir: string, record: { action: string; from: string; to: string; auditSeq: number }): boolean {
  return readAudit(dir)
    .filter((entry) => entry.seq > record.auditSeq)
    .some((entry) => entry.action === record.action && entry.from === record.from && entry.to === record.to);
}

function recoveredActor(actor: string): AuditEntry['actor'] {
  try {
    return cleanActor(actor as AuditEntry['actor']);
  } catch {
    return 'scheduler';
  }
}

async function recordRecovery(dir: string): Promise<void> {
  const recovery = recoverInterruptedWrite(dir);
  if (!recovery) return;
  const record = { ...recovery.record, actor: recoveredActor(recovery.record.actor) };
  if (recovery.state === 'completed') {
    if (recovery.intact && listRevisions(dir)[0]?.id !== record.to) snapshotRevision(dir, record.action, record.from);
    const edited = recovery.intact ? '' : ' Files changed by hand since then were kept.';
    if (!recordedSince(dir, record)) await appendAudit(dir, { actor: record.actor, action: record.action, from: record.from, to: record.to, reason: `Recorded after an interruption: the ${record.action} had finished writing.${edited}` });
    recovery.finish();
    return;
  }
  const kept = recovery.kept.length > 0 ? ` ${recovery.kept.join(', ')} changed after the interruption and was kept.` : '';
  await appendAudit(dir, { actor: record.actor, action: 'reject', from: record.from, reason: `Undid an interrupted ${record.action}: the old files were put back.${kept}` });
  recovery.finish();
}

async function withApplyLock<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const lousho = path.join(dir, '.lousho');
  if (fs.lstatSync(lousho, { throwIfNoEntry: false })?.isSymbolicLink()) throw refusal(`${lousho} is a symlink; the lock, revisions and audit log must live inside the agent directory.`);
  fs.mkdirSync(lousho, { recursive: true });
  return withFileLock(path.join(lousho, 'apply.lock'), async () => {
    await recordRecovery(dir);
    return task();
  });
}

function actorOf(approval: Approval): AuditEntry['actor'] {
  if (approval.mode === 'auto') return approval.by;
  if (typeof approval.approvedBy !== 'string' || approval.approvedBy.trim() === '') throw refusal('manual approval needs the name of the person who approved it.', 'approvedBy');
  return cleanActor(`person:${approval.approvedBy.trim()}`);
}

function checkedProposal(input: ApplyInput, current: Harness, approval: Approval): Harness {
  const { result, base } = input;
  if (result.outcome !== 'proposal' || !result.harness) throw refusal(`only a proposal with a harness can be applied; this result is '${result.outcome}'.`, 'result');
  if (writtenHash(current) !== writtenHash(base)) throw refusal('the proposal is stale: the agent directory changed after the proposal was made. Run improve again.', STALE_FIELD);
  if (writtenHash(result.harness) === writtenHash(current)) throw refusal('the proposal changes nothing.', 'result');
  const failedChecks = approval.mode === 'auto' ? result.failedChecks : undefined;
  const limits = { maxAlwaysOnChars: input.maxAlwaysOnChars ?? DEFAULT_MAX_ALWAYS_ON, ...(failedChecks && { failedChecks }) };
  const errors = validateHarness(result.harness, base, limits);
  if (errors.length > 0) throw refusal(`the proposal fails validation at write time: ${errors.join(' ')}`, 'result');
  return result.harness;
}

function snapshotBefore(dir: string, current: Harness): string {
  const id = harnessHash(current);
  const latest = listRevisions(dir)[0];
  const saved = snapshotRevision(dir, 'baseline', latest && latest.id !== id ? latest.id : undefined).id;
  if (saved !== id) throw refusal('the agent directory changed while the write was being prepared; it is stale.', STALE_FIELD);
  return saved;
}

function caseEvidence(result: ImproveResult): NonNullable<AuditEntry['evidence']>['cases'] {
  return result.cases?.map((verdict) => ({ caseId: verdict.caseId, base: `${verdict.base.passed}/${verdict.base.scored}`, final: `${verdict.final.passed}/${verdict.final.scored}` }));
}

function failureReason(error: unknown, undone: boolean): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AggregateError) return `Partly written: putting the old files back failed, so the next apply undoes it from the journal. ${message}`;
  if (error instanceof ConfigurationError) return message;
  return `Not written, the write failed: ${message}${undone ? ' The old files were put back.' : ''}`;
}

function undoQuietly(write: HarnessWrite | undefined): boolean {
  if (!write) return false;
  try {
    write.undo();
    return true;
  } catch {
    return false;
  }
}

async function auditQuietly(dir: string, entry: Parameters<typeof appendAudit>[1]): Promise<void> {
  try {
    await appendAudit(dir, entry);
  } catch {
    return;
  }
}

async function writeLocked(dir: string, actor: AuditEntry['actor'], action: 'apply' | 'rollback', choose: (current: Harness) => Harness, audit: { cycle?: string; prefix: string }): Promise<RollbackResult & { write: HarnessWrite }> {
  let from: string | undefined;
  let write: HarnessWrite | undefined;
  try {
    const current = readHarnessState(dir);
    from = harnessHash(current.harness);
    const next = choose(current.harness);
    from = snapshotBefore(dir, current.harness);
    write = writeHarnessFiles(dir, next, current, { action, actor, from, auditSeq: readAudit(dir).length });
    const to = snapshotRevision(dir, action, from).id;
    return { from, to, written: write.written, write };
  } catch (error) {
    const undone = undoQuietly(write);
    const stale = error instanceof ConfigurationError && error.field === STALE_FIELD;
    await auditQuietly(dir, { actor, action: stale ? 'stale' : 'reject', ...(from && { from }), ...(audit.cycle && { cycle: audit.cycle }), reason: `${audit.prefix}${failureReason(error, undone)}` });
    throw error;
  }
}

/** Writes a gated proposal's instructions and skills into an agent directory, records revisions and one audit entry, and returns both revision ids. */
export async function applyProposal(dir: string, input: ApplyInput, approval: Approval): Promise<ApplyResult> {
  const actor = actorOf(approval);
  return withApplyLock(dir, async () => {
    const { write, ...applied } = await writeLocked(dir, actor, 'apply', (current) => checkedProposal(input, current, approval), { cycle: input.cycle, prefix: '' });
    const evidence = { gate: input.result.reason, cases: caseEvidence(input.result) };
    await appendAudit(dir, { actor, action: 'apply', from: applied.from, to: applied.to, ...(input.cycle && { cycle: input.cycle }), reason: `Applied ${applied.written.join(', ')}.`, evidence });
    write.finish();
    return applied;
  });
}

/** Who rolls back and why, and optionally the revision the caller expects to replace. */
export interface RollbackBy {
  /** The loop stage or `person:<name>` that rolls back. */
  actor: AuditEntry['actor'];
  /** Why, as plain text. */
  reason: string;
  /** Refuse as stale unless the directory still holds this revision. */
  expectedFrom?: string;
}

/** The revisions before and after a rollback, and the files it changed. */
export interface RollbackResult {
  /** The revision the rollback replaced, saved first when it was a hand edit. */
  from: string;
  /** The restored revision. */
  to: string;
  /** The files written or removed, relative to the agent directory. */
  written: string[];
}

function sameSkillText(a: Harness['skills'][string] | undefined, b: Harness['skills'][string] | undefined): boolean {
  return a?.description.trim() === b?.description.trim() && a?.content.trim() === b?.content.trim();
}

function rollbackTarget(dir: string, to: string, current: Harness, expectedFrom: string | undefined): Harness {
  if (expectedFrom !== undefined && harnessHash(current) !== expectedFrom) throw refusal(`the directory no longer holds revision ${expectedFrom.slice(0, 12)}; it changed after the rollback was planned.`, STALE_FIELD);
  const target = listRevisions(dir).find((revision) => revision.id === to);
  if (!target) throw refusal(`there is no saved revision '${to}' in ${dir}, or its saved file is missing or corrupted; see 'lousho improve revisions'.`, 'to');
  if (writtenHash(current) === writtenHash(target.harness)) throw refusal(`the directory already holds revision ${to.slice(0, 12)}.`, 'to');
  const lost = (target.readOnly ?? []).find((name) => !sameSkillText(Object.hasOwn(current.skills, name) ? current.skills[name] : undefined, target.harness.skills[name]));
  if (lost !== undefined) throw refusal(`skill '${lost}' was read-only in revision ${to.slice(0, 12)} and has changed since, so it can't be restored safely.`, 'to');
  return target.harness;
}

/** Restores a saved revision through the same writer, as a new revision; never rewrites history. */
export async function rollbackHarness(dir: string, to: string, by: RollbackBy): Promise<RollbackResult> {
  const actor = cleanActor(by.actor);
  return withApplyLock(dir, async () => {
    const { write, ...rolled } = await writeLocked(dir, actor, 'rollback', (current) => rollbackTarget(dir, to, current, by.expectedFrom), { prefix: `Rollback to ${to.slice(0, 12)} not done: ` });
    await appendAudit(dir, { actor, action: 'rollback', from: rolled.from, to: rolled.to, reason: by.reason });
    write.finish();
    return rolled;
  });
}

/** The newest revision whose latest guard run passed, else the first baseline. */
export function lastGoodRevision(dir: string): string | undefined {
  const revisions = listRevisions(dir);
  const latestGuard = new Map<string, AuditEntry['action']>();
  for (const entry of readAudit(dir)) if ((entry.action === 'guard-pass' || entry.action === 'guard-fail') && entry.to !== undefined) latestGuard.set(entry.to, entry.action);
  const passed = revisions.find((revision) => latestGuard.get(revision.id) === 'guard-pass')?.id;
  return passed ?? revisions.filter((revision) => revision.source === 'baseline').at(-1)?.id;
}
