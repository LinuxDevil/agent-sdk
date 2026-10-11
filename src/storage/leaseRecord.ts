/**
 * Run lease records of the file and SQLite stores: who holds the lease on
 * a checkpoint id and until when. A lease is free once it expired - or, before
 * that, when its holder is gone: a run of a process on this host that has
 * exited (or of this very process, no longer running), so a crashed process's
 * run can be resumed at once after a restart on the same machine instead of
 * waiting for the lease to expire.
 */

import { hostname } from 'node:os';
import { isLiveLeaseOwner } from '../execution/runLease';

/** A lease as the file and SQLite stores keep it. */
export interface LeaseRecord {
  owner: string;
  /** Epoch ms. */
  expiresAt: number;
  /** The host of the process that took it. */
  host?: string;
}

/** A lease the file and SQLite stores write: always with its host. */
type NewLeaseRecord = LeaseRecord & { host: string };

/** A lease for `owner` until `ttlMs` from now, taken on this host. */
export function newLeaseRecord(owner: string, ttlMs: number): NewLeaseRecord {
  return { owner, expiresAt: Date.now() + ttlMs, host: hostname() };
}

/** The process id in a run lease owner (`<pid>:<uuid>`, see `runLease.ts`); `undefined` for any other owner (a claim). */
function ownerPid(owner: string): number | undefined {
  const pid = Number(/^(\d+):/.exec(owner)?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Whether the run holding `record` is known to be gone (see the module comment). */
function holderGone(record: LeaseRecord): boolean {
  const pid = ownerPid(record.owner);
  if (pid === undefined || record.host !== hostname()) return false;
  if (pid === process.pid) return !isLiveLeaseOwner(record.owner);
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Whether `owner` may take the lease `record` holds now (none, its own, expired, or its holder is gone). */
export function leaseAvailable(record: LeaseRecord | undefined, owner: string): boolean {
  if (!record || record.owner === owner || record.expiresAt <= Date.now()) return true;
  return holderGone(record);
}

/** `raw` as a lease record, or `undefined` when it is missing or unreadable (an unreadable lease is free). */
export function parseLeaseRecord(raw: string | undefined): LeaseRecord | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<LeaseRecord> | null;
    return typeof parsed?.owner === 'string' && typeof parsed.expiresAt === 'number' ? (parsed as LeaseRecord) : undefined;
  } catch {
    return undefined;
  }
}

/** Expired leases (and one-off claims) older than this are swept away. */
export const LEASE_SWEEP_AGE_MS = 10 * 60_000;
