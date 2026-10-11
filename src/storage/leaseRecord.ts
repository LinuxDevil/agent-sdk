/**
 * Run lease records of the file and SQLite stores: who holds the lease on a
 * checkpoint id and until when.
 *
 * A lease is free once it expired, judged with a grace of one more lease
 * period (`ttlMs`), so replicas whose clocks disagree by less than that do not
 * take over each other's live runs. Before that, it is free only when its
 * holder is provably gone:
 *
 * - a run of this very JS realm (this thread and this copy of the SDK, or
 *   another copy loaded in the same thread) that no longer runs; or
 * - on Linux, a run of a process that has exited, on this same boot and in this
 *   same PID namespace (the record carries the boot id, the PID namespace and
 *   the process start time): two containers with one hostname on a shared
 *   volume, or a process restarted in a new container, wait for the expiry.
 *   Elsewhere (macOS, Windows: no PID namespaces) a process id of this host
 *   that no longer exists.
 *
 * A run of another worker thread of this process is never taken over early:
 * its liveness cannot be seen from here.
 */

import { readFileSync, readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { isLiveLeaseOwner, leaseOwnerInstance, localLeaseInstance } from '../execution/runLease';

/** A lease as the file and SQLite stores keep it. */
export interface LeaseRecord {
  owner: string;
  /** Epoch ms. */
  expiresAt: number;
  /** The host of the process that took it. */
  host?: string;
  /** Linux: the boot id and PID namespace of the process that took it (`<boot id>/<pid namespace>`). */
  pidSpace?: string;
  /** Linux: that process's start time (clock ticks since boot), telling it from a later process with its pid. */
  pidStart?: string;
  /** The lease period it was taken for, ms: an expired lease is free only after one more (clock-skew grace). */
  ttlMs?: number;
}

/** This process as a lease record names it. */
interface ProcessIdentity {
  host: string;
  pidSpace?: string;
  pidStart?: string;
}

let identity: ProcessIdentity | undefined;

/** The start time (field 22 of `/proc/<pid>/stat`) of `pid`; `undefined` when it does not exist (or there is no procfs). */
function processStart(pid: number | 'self'): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // `<pid> (<comm>) <state> ...`: the command may hold spaces and parentheses, so fields are counted after the last ')'.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}

/** This process's host, and on Linux its PID space and start time (read once). */
function localIdentity(): ProcessIdentity {
  if (identity) return identity;
  identity = { host: hostname() };
  if (process.platform !== 'linux') return identity;
  try {
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const namespace = readlinkSync('/proc/self/ns/pid');
    const self = readFileSync('/proc/self/stat', 'utf8');
    const start = processStart('self');
    // A procfs of another PID namespace (mounted without `--mount-proc`) names other processes: not usable.
    if (boot && namespace && start && Number.parseInt(self, 10) === process.pid) identity = { ...identity, pidSpace: `${boot}/${namespace}`, pidStart: start };
  } catch {
    // no procfs: only same-realm runs are known to be gone
  }
  return identity;
}

/** A lease for `owner` until `ttlMs` from now, taken by this process. */
export function newLeaseRecord(owner: string, ttlMs: number): LeaseRecord & { host: string } {
  return { owner, expiresAt: Date.now() + ttlMs, ttlMs, ...localIdentity() };
}

/** The process id in a run lease owner (`<pid>:<instance>:<uuid>`, see `runLease.ts`); `undefined` for any other owner (a claim). */
function ownerPid(owner: string): number | undefined {
  const pid = Number(/^(\d+):/.exec(owner)?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Whether the run holding `record` is known to be gone (see the module comment). */
function holderGone(record: LeaseRecord): boolean {
  // A run of this realm: it is gone when it no longer runs here.
  if (leaseOwnerInstance(record.owner) === localLeaseInstance()) return !isLiveLeaseOwner(record.owner);
  const pid = ownerPid(record.owner);
  const local = localIdentity();
  if (pid === undefined || record.host !== local.host || record.pidSpace !== local.pidSpace) return false;
  if (local.pidSpace !== undefined) {
    if (!record.pidStart) return false;
    // Our own pid: an earlier process with this pid (it is gone) unless the start time is ours (another thread: alive).
    if (pid === process.pid) return record.pidStart !== local.pidStart;
    return processStart(pid) !== record.pidStart;
  }
  if (process.platform === 'linux' || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Whether the lease `record` has expired, with a grace of one more lease period for clocks that disagree. */
function leaseExpired(record: LeaseRecord): boolean {
  return record.expiresAt + (record.ttlMs ?? 0) <= Date.now();
}

/** Whether `owner` may take the lease `record` holds now (none, its own, expired, or its holder is gone). */
export function leaseAvailable(record: LeaseRecord | undefined, owner: string): boolean {
  if (!record || record.owner === owner || leaseExpired(record)) return true;
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
