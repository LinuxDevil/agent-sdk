/**
 * LOU-D43 `CheckpointStore.history()` contract suite, shared so every store
 * that keeps a history runs the same assertions: the SDK's own stores
 * (checkpointHistory.contract.test.ts) and Agent Forge's `FileCheckpointStore`
 * (apps/agent-forge/server/__tests__/checkpointStore.test.ts, LOU-D45).
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_CHECKPOINT_HISTORY_LIMIT, type CheckpointStore } from '../checkpoint';
import { makeCheckpoint } from '../../storage/sqlite/__fixtures__/storeContracts';

/** Returns a fresh, empty store keeping at most `historyLimit` entries per session. */
export type CheckpointHistoryStoreFactory = (options?: { historyLimit?: number }) => CheckpointStore;

const save = (store: CheckpointStore, sessionId: string, stepIndex: number, extra = {}) =>
  store.save(sessionId, makeCheckpoint({ sessionId, stepIndex, ...extra }));

export function describeCheckpointHistoryContract(name: string, factory: CheckpointHistoryStoreFactory): void {
  describe(`CheckpointStore.history contract: ${name}`, () => {
    it('is empty for a session that was never saved', async () => {
      expect(await factory().history?.('nope')).toEqual([]);
    });

    it('lists every save newest first with step, savedAt, status and the checkpoint', async () => {
      const store = factory();
      await save(store, 's', 1);
      await save(store, 's', 2, { status: 'awaiting-approval', approvalId: 'a1' });
      await save(store, 's', 3, { status: 'finished', businessState: { orderId: 7 } });

      const history = (await store.history?.('s')) ?? [];
      expect(history.map((entry) => [entry.step, entry.status])).toEqual([
        [3, 'finished'],
        [2, 'awaiting-approval'],
        [1, 'in-progress'], // a checkpoint without a status counts as in-progress
      ]);
      expect(history[0].checkpoint).toEqual(makeCheckpoint({ sessionId: 's', stepIndex: 3, status: 'finished', businessState: { orderId: 7 } }));
      expect(history[1].checkpoint.approvalId).toBe('a1');
      for (const entry of history) expect(new Date(entry.savedAt).toISOString()).toBe(entry.savedAt);
      expect(history[0].savedAt >= history[2].savedAt).toBe(true);
      expect((await store.load('s'))?.stepIndex).toBe(3); // load still returns the latest only
    });

    it('keeps two saves of the same step as two entries', async () => {
      const store = factory();
      await save(store, 's', 4);
      await save(store, 's', 4, { status: 'finished' });
      expect((await store.history?.('s'))?.map((entry) => entry.status)).toEqual(['finished', 'in-progress']);
    });

    it('bounds the ring: the oldest entries are dropped past historyLimit (default 50)', async () => {
      const small = factory({ historyLimit: 3 });
      for (let step = 0; step < 5; step++) await save(small, 's', step);
      expect((await small.history?.('s'))?.map((entry) => entry.step)).toEqual([4, 3, 2]);

      const standard = factory();
      for (let step = 0; step < DEFAULT_CHECKPOINT_HISTORY_LIMIT + 5; step++) await save(standard, 's', step);
      const kept = (await standard.history?.('s')) ?? [];
      expect(kept).toHaveLength(DEFAULT_CHECKPOINT_HISTORY_LIMIT);
      expect([kept[0].step, kept[kept.length - 1].step]).toEqual([DEFAULT_CHECKPOINT_HISTORY_LIMIT + 4, 5]);
    });

    it('limit returns the newest N entries', async () => {
      const store = factory();
      for (let step = 0; step < 5; step++) await save(store, 's', step);
      expect((await store.history?.('s', { limit: 2 }))?.map((entry) => entry.step)).toEqual([4, 3]);
      expect(await store.history?.('s', { limit: 0 })).toEqual([]);
      expect(await store.history?.('s', { limit: 99 })).toHaveLength(5);
    });

    it('keeps sessions apart', async () => {
      const store = factory();
      await save(store, 'a', 1);
      await save(store, 'b', 2);
      await save(store, 'b', 3);
      expect((await store.history?.('a'))?.map((entry) => entry.step)).toEqual([1]);
      expect((await store.history?.('b'))?.map((entry) => entry.step)).toEqual([3, 2]);
    });

    it('delete() clears the history with the checkpoint', async () => {
      const store = factory();
      await save(store, 's', 1);
      await save(store, 'other', 1);
      await store.delete('s');
      expect(await store.load('s')).toBeNull();
      expect(await store.history?.('s')).toEqual([]);
      expect(await store.history?.('other')).toHaveLength(1);
    });

    it('delete({ keepHistory: true }) drops the checkpoint but keeps the history, which keeps growing', async () => {
      const store = factory();
      await save(store, 's', 1);
      await save(store, 's', 2);
      await store.delete('s', { keepHistory: true });
      expect(await store.load('s')).toBeNull();
      expect((await store.history?.('s'))?.map((entry) => entry.step)).toEqual([2, 1]);
      await save(store, 's', 3);
      expect((await store.history?.('s'))?.map((entry) => entry.step)).toEqual([3, 2, 1]);
    });

    it('returns copies: changing a returned entry changes nothing stored', async () => {
      const store = factory();
      await save(store, 's', 1);
      const [entry] = (await store.history?.('s')) ?? [];
      entry.checkpoint.messages.length = 0;
      expect((await store.history?.('s'))?.[0].checkpoint.messages).toHaveLength(2);
    });

    it('historyLimit 0 keeps no history; a negative or fractional one is refused', async () => {
      const off = factory({ historyLimit: 0 });
      await save(off, 's', 1);
      expect(await off.history?.('s')).toEqual([]);
      expect((await off.load('s'))?.stepIndex).toBe(1);
      expect(() => factory({ historyLimit: -1 })).toThrow(/historyLimit/);
      expect(() => factory({ historyLimit: 1.5 })).toThrow(/historyLimit/);
    });
  });
}
