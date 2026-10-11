/**
 * Run leases: while a checkpointed run executes, it holds a lease on
 * its checkpoint id in the checkpoint store - an owner id with an expiry,
 * renewed by a heartbeat. Another process (or another store object over the
 * same data) that tries to run or resume the same id while the lease is live
 * fails with `LOUSHO_SESSION_BUSY` before anything runs, instead of re-running
 * the live run's tool calls. A lease whose holder died expires after
 * {@link RUN_LEASE_TTL_MS} (the file and SQLite stores wait one more period for
 * clock skew, and take over at once when the holder is provably gone, see
 * `leaseRecord.ts`), so a crashed run can still be resumed.
 *
 * Taking a lease is the store's own compare-and-swap
 * (`CheckpointStore.acquireLease`); a store without it (a custom store) runs
 * without leases, as before. The owner id is the fencing token: a heartbeat
 * only renews a lease its owner still holds (`renewLease`), and the run's
 * checkpoints are saved only while it does (`saveIfLeased`), so a run that
 * stalled past its lease cannot overwrite the new holder's progress.
 * No Node builtins: Worker code runs it too.
 */

import type { Checkpoint, CheckpointStore } from './checkpoint';
import { SDKError } from './errors';

/** How long a run lease lasts without a heartbeat, in ms; a live run renews it every third of that. */
const RUN_LEASE_TTL_MS = 30_000;

/** Lease state of one JS realm (a thread), shared by every copy of this module loaded in it. */
interface LeaseRealm {
  /** A random id of the realm, part of every lease owner it takes. */
  readonly instance: string;
  /** Lease owners held by live runs of the realm - a store asks, to tell a crashed run of this realm from a live one. */
  readonly live: Set<string>;
}

const REALM_KEY = Symbol.for('lousho.runLeaseRealm');

function leaseRealm(): LeaseRealm {
  const holder = globalThis as { [REALM_KEY]?: LeaseRealm };
  holder[REALM_KEY] ??= { instance: globalThis.crypto.randomUUID(), live: new Set() };
  return holder[REALM_KEY];
}

/** Whether `owner` is a lease held by a run that is still running in this realm. */
export function isLiveLeaseOwner(owner: string): boolean {
  return leaseRealm().live.has(owner);
}

/** The realm id of the leases this realm takes. */
export function localLeaseInstance(): string {
  return leaseRealm().instance;
}

/** The realm id in a run lease owner (`<pid>:<realm>:<uuid>`); `undefined` for any other owner (a claim, an older owner). */
export function leaseOwnerInstance(owner: string): string | undefined {
  return /^(?:\d+|worker):([0-9a-f-]{36}):[0-9a-f-]{36}$/.exec(owner)?.[1];
}

/** A held run lease. */
export interface RunLease {
  readonly id: string;
  readonly owner: string;
  /** Set once the lease was found taken over or gone (it expired, e.g. after the process stalled): the run must stop writing. */
  readonly lost: boolean;
  /**
   * Saves `checkpoint` as the run's checkpoint, only while this lease still
   * holds the id (atomically with the store's `saveIfLeased`); otherwise
   * rejects with `LOUSHO_SESSION_BUSY` and saves nothing.
   */
  save(checkpoint: Checkpoint): Promise<void>;
  release(): Promise<void>;
}

/** A unique owner id: the process (when there is one), the realm and a random part. */
function newOwner(): string {
  const pid = (globalThis as { process?: { pid?: number } }).process?.pid;
  return `${pid ?? 'worker'}:${localLeaseInstance()}:${globalThis.crypto.randomUUID()}`;
}

/** The error a run gets when another live run holds its id. */
export function runBusyError(id: string, reason = 'is running elsewhere'): SDKError {
  return new SDKError(
    `The run checkpointed as '${id}' ${reason} (another process, replica or store object holds its run lease), ` +
      `so it was not started or resumed here and nothing ran. Wait for that run to finish and try again; ` +
      `a lease left by a process that died expires after ${(2 * RUN_LEASE_TTL_MS) / 1000} s at most.`,
    'LOUSHO_SESSION_BUSY'
  );
}

/**
 * Takes the run lease on `id` in `store`, or `undefined` when the store has no
 * leases. Throws `LOUSHO_SESSION_BUSY` when another live owner holds it. The
 * lease renews itself until `release()`.
 */
export async function acquireRunLease(store: CheckpointStore, id: string, ttlMs = RUN_LEASE_TTL_MS): Promise<RunLease | undefined> {
  const acquire = store.acquireLease?.bind(store);
  if (!acquire) return undefined;
  const { live } = leaseRealm();
  const owner = newOwner();
  live.add(owner);
  let taken = false;
  try {
    taken = await acquire(id, owner, ttlMs);
  } finally {
    if (!taken) live.delete(owner);
  }
  if (!taken) throw runBusyError(id);
  let lost = false;
  // A lease that is gone (released by a new holder that finished, swept) is not taken again: only its owner's own is renewed.
  const renew = (): Promise<boolean> => (store.renewLease ? store.renewLease(id, owner, ttlMs) : acquire(id, owner, ttlMs));
  const heartbeat = setInterval(() => {
    renew().then(
      (renewed) => {
        if (!renewed) lost = true;
      },
      () => undefined
    );
  }, Math.max(10, Math.floor(ttlMs / 3)));
  (heartbeat as { unref?: () => void }).unref?.();
  const lostError = () => {
    lost = true;
    return runBusyError(id, 'was taken over by another process after this run lost its lease (it stalled)');
  };
  let released = false;
  return {
    id,
    owner,
    get lost() {
      return lost;
    },
    async save(checkpoint) {
      if (lost) throw lostError();
      if (store.saveIfLeased) {
        if (!(await store.saveIfLeased(id, checkpoint, owner))) throw lostError();
        return;
      }
      // A store without a fenced save: the lease is renewed (still ours) right before the save.
      if (!(await renew())) throw lostError();
      await store.save(id, checkpoint);
    },
    async release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      live.delete(owner);
      await store.releaseLease?.(id, owner).catch(() => undefined);
    },
  };
}

/**
 * `store` with its saves of the lease's id fenced by `lease` (see
 * {@link RunLease.save}); everything else goes to `store` as it is.
 */
export function fencedCheckpointStore(store: CheckpointStore, lease: RunLease | undefined): CheckpointStore;
export function fencedCheckpointStore(store: CheckpointStore | undefined, lease: RunLease | undefined): CheckpointStore | undefined;
export function fencedCheckpointStore(store: CheckpointStore | undefined, lease: RunLease | undefined): CheckpointStore | undefined {
  if (!store || !lease) return store;
  const save = (id: string, checkpoint: Checkpoint) => (id === lease.id ? lease.save(checkpoint) : store.save(id, checkpoint));
  return new Proxy(store, {
    get(target, key) {
      if (key === 'save') return save;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
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
