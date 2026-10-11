/** Run leases: the owner id fences the run's saves, and the heartbeat never takes back a lease that is gone. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireRunLease, fencedCheckpointStore } from './runLease';
import { memoryStore } from '../storage/agentStore';
import { makeCheckpoint } from '../storage/sqlite/__fixtures__/storeContracts';
import type { CheckpointStore } from './checkpoint';

afterEach(() => {
  vi.useRealTimers();
});

describe('run lease fencing', () => {
  it('saves only while the lease is held; once another owner took it, the save fails with LOUSHO_SESSION_BUSY and writes nothing', async () => {
    const store = memoryStore().checkpoints;
    const lease = (await acquireRunLease(store, 'job'))!;
    await lease.save(makeCheckpoint({ sessionId: 'job', stepIndex: 1 }));
    expect((await store.load('job'))?.stepIndex).toBe(1);

    // The holder stalls past its lease and another owner takes it (here: freed by hand) and saves its own progress.
    await store.releaseLease!('job', lease.owner);
    expect(await store.acquireLease!('job', 'other', 60_000)).toBe(true);
    await store.saveIfLeased!('job', makeCheckpoint({ sessionId: 'job', stepIndex: 7 }), 'other');

    await expect(lease.save(makeCheckpoint({ sessionId: 'job', stepIndex: 2 }))).rejects.toMatchObject({ code: 'LOUSHO_SESSION_BUSY' });
    expect(lease.lost).toBe(true);
    expect((await store.load('job'))?.stepIndex).toBe(7);
    await lease.release();
  });

  it('the heartbeat does not take back a lease that was released by another owner', async () => {
    vi.useFakeTimers();
    const store = memoryStore().checkpoints;
    const lease = (await acquireRunLease(store, 'job', 30))!;
    // Another owner took the lease over and finished: it is gone.
    await store.releaseLease!('job', lease.owner);
    expect(await store.acquireLease!('job', 'other', 30)).toBe(true);
    await store.releaseLease!('job', 'other');
    await vi.advanceTimersByTimeAsync(20);
    expect(lease.lost).toBe(true);
    expect(await store.acquireLease!('job', 'third', 30)).toBe(true);
    await lease.release();
  });

  it('a store without saveIfLeased gets the lease renewed right before each save', async () => {
    const base = memoryStore().checkpoints;
    const store: CheckpointStore = {
      save: (id, checkpoint) => base.save(id, checkpoint),
      load: (id) => base.load(id),
      delete: (id) => base.delete(id),
      acquireLease: (id, owner, ttlMs) => base.acquireLease!(id, owner, ttlMs),
      renewLease: (id, owner, ttlMs) => base.renewLease!(id, owner, ttlMs),
      releaseLease: (id, owner) => base.releaseLease!(id, owner),
    };
    const renew = vi.spyOn(store, 'renewLease');
    const lease = (await acquireRunLease(store, 'job'))!;
    await lease.save(makeCheckpoint({ sessionId: 'job', stepIndex: 1 }));
    expect(renew).toHaveBeenCalledTimes(1);
    await lease.release();
  });

  it('fencedCheckpointStore fences saves of the lease id only', async () => {
    const store = memoryStore().checkpoints;
    const lease = (await acquireRunLease(store, 'job'))!;
    const fenced = fencedCheckpointStore(store, lease);
    await store.acquireLease!('elsewhere', 'other', 60_000);
    await fenced.save('elsewhere', makeCheckpoint({ sessionId: 'elsewhere', stepIndex: 3 }));
    expect((await fenced.load('elsewhere'))?.stepIndex).toBe(3);
    await lease.release();
    await expect(fenced.save('job', makeCheckpoint({ sessionId: 'job', stepIndex: 1 }))).rejects.toMatchObject({ code: 'LOUSHO_SESSION_BUSY' });
    expect(fencedCheckpointStore(store, undefined)).toBe(store);
  });
});
