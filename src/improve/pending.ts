import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError } from '../execution/errors';
import { withFileLock } from '../storage/fileLock';
import { appendAudit, cleanActor, type AuditEntry } from './audit';
import { harnessHash, isHarness } from './revisions';
import type { Harness, ImproveResult } from './types';

/** A proposal waiting for a person, saved under .lousho/proposals/. */
export interface PendingProposal {
  /** The first 12 characters of the proposed harness's hash. */
  id: string;
  /** When it was queued, as an ISO timestamp. */
  createdAt: string;
  /** The cycle that made it. */
  cycle?: string;
  /** The gated result, with the proposed harness. */
  result: ImproveResult;
  /** The harness it was made against. */
  base: Harness;
  /** The review card, as printed. */
  card: string;
  /** The instructions length limit the gate used, re-checked at approval. */
  maxAlwaysOnChars?: number;
  /** Set when an approval found the directory had changed since. */
  staleAt?: string;
  /** Why the last approval was refused, when it was not stale. */
  failure?: string;
}

const FOLDER = path.join('.lousho', 'proposals');
const REJECTED = 'rejected';
const ID = /^[0-9a-f]{12}$/;

/** Whether text has the shape of a pending proposal id: 12 lowercase hex characters. */
export const isPendingId = (id: string): boolean => ID.test(id);

export function folderOf(dir: string): string {
  return path.join(dir, FOLDER);
}

function checkedId(id: string): string {
  if (!ID.test(id)) throw new ConfigurationError("That is not a pending proposal id: ids are 12 lowercase hex characters, as 'lousho improve pending' prints them.", 'id');
  return id;
}

function refuseSymlinks(dir: string): void {
  for (const part of [path.join(dir, '.lousho'), folderOf(dir), path.join(folderOf(dir), REJECTED)]) {
    if (lstatSync(part, { throwIfNoEntry: false })?.isSymbolicLink()) throw new ConfigurationError(`${part} is a symlink; pending proposals must live inside the agent directory.`, 'proposals');
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(temp, 'wx', 0o644);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

function isPending(value: unknown, name: string): value is PendingProposal {
  const item = value as PendingProposal | undefined;
  if (typeof item?.id !== 'string' || `${item.id}.json` !== name || typeof item.createdAt !== 'string' || typeof item.card !== 'string') return false;
  if (item.result?.outcome !== 'proposal' || !isHarness(item.result.harness) || !isHarness(item.base)) return false;
  return harnessHash(item.result.harness).slice(0, 12) === item.id;
}

function readPending(file: string): PendingProposal | undefined {
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isPending(value, path.basename(file)) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function withProposalsLock<T>(dir: string, task: () => Promise<T>): Promise<T> {
  refuseSymlinks(dir);
  mkdirSync(folderOf(dir), { recursive: true });
  return withFileLock(path.join(folderOf(dir), '.lock'), async () => {
    refuseSymlinks(dir);
    return task();
  });
}

/** Queues a gated proposal for a person in manual mode, audits `propose`, and returns its id. */
export async function savePending(dir: string, input: { result: ImproveResult; base: Harness; card: string; cycle?: string; maxAlwaysOnChars?: number }): Promise<PendingProposal> {
  const { result, base, card, cycle, maxAlwaysOnChars } = input;
  if (result.outcome !== 'proposal' || !result.harness) throw new ConfigurationError(`savePending: only a proposal with a harness can be queued; this result is '${result.outcome}'.`, 'result');
  const to = harnessHash(result.harness);
  const pending: PendingProposal = { id: to.slice(0, 12), createdAt: new Date().toISOString(), ...(cycle && { cycle }), result, base, card, ...(maxAlwaysOnChars !== undefined && { maxAlwaysOnChars }) };
  return withProposalsLock(dir, async () => {
    if (lstatSync(path.join(folderOf(dir), REJECTED, `${pending.id}.json`), { throwIfNoEntry: false })) throw new ConfigurationError(`savePending: proposal ${pending.id} was rejected before, so it is not queued again.`, 'result');
    writeJson(path.join(folderOf(dir), `${pending.id}.json`), pending);
    await appendAudit(dir, { actor: 'gate', action: 'propose', from: harnessHash(base), to, ...(cycle && { cycle }), reason: `Queued for approval as ${pending.id}: ${result.reason}` });
    return pending;
  });
}

/** Pending proposals, newest first; files that are unreadable or don't match their id are left out. */
export function listPending(dir: string): PendingProposal[] {
  refuseSymlinks(dir);
  const folder = folderOf(dir);
  if (!lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(folder)
    .filter((name) => /^[0-9a-f]{12}\.json$/.test(name))
    .flatMap((name) => readPending(path.join(folder, name)) ?? [])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function pendingOrThrow(dir: string, id: string): PendingProposal {
  const pending = readPending(path.join(folderOf(dir), `${checkedId(id)}.json`));
  if (!pending) throw new ConfigurationError(`No pending proposal ${id} in ${dir}, or its file doesn't match its id; see 'lousho improve pending'.`, 'id');
  return pending;
}

/** One pending proposal, checked against its id. */
export function readPendingProposal(dir: string, id: string): PendingProposal {
  refuseSymlinks(dir);
  return pendingOrThrow(dir, id);
}

export function markRefused(file: string, pending: PendingProposal, error: unknown): void {
  if (!(error instanceof ConfigurationError)) return;
  const now = new Date().toISOString();
  writeJson(file, error.field === 'base' ? { ...pending, staleAt: now } : { ...pending, failure: error.message });
}

/** Rejects a pending proposal: moves it to .lousho/proposals/rejected/ and audits `reject` with the reason. */
export async function rejectPending(dir: string, id: string, by: string, reason: string): Promise<AuditEntry> {
  const actor = cleanActor(`person:${by.trim()}`);
  return withProposalsLock(dir, async () => {
    const pending = pendingOrThrow(dir, id);
    const from = path.join(folderOf(dir), `${pending.id}.json`);
    const to = path.join(folderOf(dir), REJECTED, `${pending.id}.json`);
    mkdirSync(path.dirname(to), { recursive: true });
    renameSync(from, to);
    try {
      return await appendAudit(dir, { actor, action: 'reject', from: harnessHash(pending.base), to: harnessHash(pending.result.harness as Harness), ...(pending.cycle && { cycle: pending.cycle }), reason: `Rejected ${pending.id}: ${reason}` });
    } catch (error) {
      renameSync(to, from);
      throw error;
    }
  });
}
