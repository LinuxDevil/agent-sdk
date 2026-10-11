/**
 * Run leases: while a checkpointed run executes, it holds a lease on
 * its checkpoint id in the checkpoint store - an owner id with an expiry,
 * renewed by a heartbeat. Another process (or another store object over the
 * same data) that tries to run or resume the same id while the lease is live
 * fails with `LOUSHO_SESSION_BUSY` before anything runs, instead of re-running
 * the live run's tool calls. A lease whose holder died expires after
 * {@link RUN_LEASE_TTL_MS} (the file and SQLite stores also take over at once
 * when the holder's process is gone from the same host), so a crashed run can
 * still be resumed.
 *
 * Taking a lease is the store's own compare-and-swap
 * (`CheckpointStore.acquireLease`); a store without it (a custom store) runs
 * without leases, as before. No Node builtins: Worker code runs it too.
 */

import type { CheckpointStore } from './checkpoint';
import { SDKError } from './errors';

/** How long a run lease lasts without a heartbeat, in ms; a live run renews it every third of that. */
const RUN_LEASE_TTL_MS = 30_000;

/** Lease owners held by live runs of this process - a store asks, to tell a crashed run of this process from a live one. */
const liveOwners = new Set<string>();

/** Whether `owner` is a lease held by a run that is still running in this process. */
export function isLiveLeaseOwner(owner: string): boolean {
  return liveOwners.has(owner);
}

/** A held run lease. */
export interface RunLease {
  readonly id: string;
  readonly owner: string;
  /** Set when a heartbeat found the lease taken over (it expired, e.g. after the process stalled): the run must stop writing. */
  readonly lost: boolean;
  release(): Promise<void>;
}

/** A unique owner id: the process (when there is one) and a random part. */
function newOwner(): string {
  const pid = (globalThis as { process?: { pid?: number } }).process?.pid;
  return `${pid ?? 'worker'}:${globalThis.crypto.randomUUID()}`;
}

/** The error a run gets when another live run holds its id. */
export function runBusyError(id: string, reason = 'is running elsewhere'): SDKError {
  return new SDKError(
    `The run checkpointed as '${id}' ${reason} (another process, replica or store object holds its run lease), ` +
      `so it was not started or resumed here and nothing ran. Wait for that run to finish and try again; ` +
      `a lease left by a process that died expires after ${RUN_LEASE_TTL_MS / 1000} s.`,
    'LOUSHO_SESSION_BUSY'
  );
}

/**
 * Takes the run lease on `id` in `store`, or `undefined` when the store has no
 * leases. Throws `LOUSHO_SESSION_BUSY` when another live owner holds it. The
 * lease renews itself until `release()`.
 */
export async function acquireRunLease(store: CheckpointStore, id: string, ttlMs = RUN_LEASE_TTL_MS): Promise<RunLease | undefined> {
  if (!store.acquireLease) return undefined;
  const owner = newOwner();
  liveOwners.add(owner);
  let taken = false;
  try {
    taken = await store.acquireLease(id, owner, ttlMs);
  } finally {
    if (!taken) liveOwners.delete(owner);
  }
  if (!taken) throw runBusyError(id);
  let lost = false;
  const heartbeat = setInterval(() => {
    store.acquireLease?.(id, owner, ttlMs).then(
      (renewed) => {
        if (!renewed) lost = true;
      },
      () => undefined
    );
  }, Math.max(10, Math.floor(ttlMs / 3)));
  (heartbeat as { unref?: () => void }).unref?.();
  let released = false;
  return {
    id,
    owner,
    get lost() {
      return lost;
    },
    async release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      liveOwners.delete(owner);
      await store.releaseLease?.(id, owner).catch(() => undefined);
    },
  };
}

/**
 * Claims a one-off job (a schedule's tick) for `ttlMs`: `true` for the one
 * caller, across processes and replicas sharing `store`, that gets it first;
 * `true` too when the store has no leases (nothing to claim with). The claim
 * is not released: it expires.
 */
export async function claimOnce(store: CheckpointStore | undefined, id: string, ttlMs: number): Promise<boolean> {
  if (!store?.acquireLease) return true;
  return store.acquireLease(id, `claim:${newOwner()}`, ttlMs);
}

/**
 * Internal `ExecuteOptions` key: a lease the caller already holds on the run's
 * id (an approval resume holds it across the decided call and the
 * continuation), so `execute()` neither takes nor releases its own.
 */
export const HELD_RUN_LEASE = Symbol('lousho.heldRunLease');

/**
 * Internal `ExecuteOptions` key: the run's `input` already holds everything its
 * checkpoint holds (an approval resume saved the decided call's result there
 * first), so `execute()` starts from `input` and overwrites the checkpoint
 * instead of continuing it.
 */
export const REPLACES_CHECKPOINT = Symbol('lousho.replacesCheckpoint');

/** The internal keys above, as they ride on `ExecuteOptions`. */
export interface RunLeaseOptions {
  [HELD_RUN_LEASE]?: RunLease;
  [REPLACES_CHECKPOINT]?: boolean;
}
