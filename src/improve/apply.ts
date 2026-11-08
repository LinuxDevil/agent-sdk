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

async function recordRecovery(dir: string): Promise<void> {
  const recovery = recoverInterruptedWrite(dir);
  if (!recovery) return;
  const { record } = recovery;
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

async function applyLocked(dir: string, input: ApplyInput, approval: Approval, actor: AuditEntry['actor']): Promise<ApplyResult & { write: HarnessWrite }> {
  let from: string | undefined;
  let write: HarnessWrite | undefined;
  try {
    const current = readHarnessState(dir);
    from = harnessHash(current.harness);
    const next = checkedProposal(input, current.harness, approval);
    from = snapshotBefore(dir, current.harness);
    write = writeHarnessFiles(dir, next, current, { action: 'apply', actor, from, auditSeq: readAudit(dir).length });
    const to = snapshotRevision(dir, 'apply', from).id;
    return { from, to, written: write.written, write };
  } catch (error) {
    const undone = undoQuietly(write);
    const stale = error instanceof ConfigurationError && error.field === STALE_FIELD;
    await auditQuietly(dir, { actor, action: stale ? 'stale' : 'reject', ...(from && { from }), ...(input.cycle && { cycle: input.cycle }), reason: failureReason(error, undone) });
    throw error;
  }
}

/** Writes a gated proposal's instructions and skills into an agent directory, records revisions and one audit entry, and returns both revision ids. */
export async function applyProposal(dir: string, input: ApplyInput, approval: Approval): Promise<ApplyResult> {
  const actor = actorOf(approval);
  return withApplyLock(dir, async () => {
    const { write, ...applied } = await applyLocked(dir, input, approval, actor);
    const evidence = { gate: input.result.reason, cases: caseEvidence(input.result) };
    await appendAudit(dir, { actor, action: 'apply', from: applied.from, to: applied.to, ...(input.cycle && { cycle: input.cycle }), reason: `Applied ${applied.written.join(', ')}.`, evidence });
    write.finish();
    return applied;
  });
}
