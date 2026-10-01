/**
 * LOU-D43: one contract suite for `CheckpointStore.history()`, run against
 * every store that implements it (the in-memory store, `SqliteStore` and
 * `LocalStorageCheckpointStore`), plus the `getCheckpointHistory()` helper on
 * stores that do not.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  getCheckpointHistory,
  DEFAULT_CHECKPOINT_HISTORY_LIMIT,
  LocalStorageCheckpointStore,
  type CheckpointStore,
} from './checkpoint';
import { StorageService } from '../storage/StorageService';
import { memoryStore } from '../storage/agentStore';
import { SqliteStore } from '../storage/sqlite';
import { KVCheckpointStore } from '../deploy/kvCheckpointStore';
import { createFakeFs } from './__fixtures__/fakeFs';
import { makeCheckpoint } from '../storage/sqlite/__fixtures__/storeContracts';

type Factory = (options?: { historyLimit?: number }) => CheckpointStore;

const sqliteStores: SqliteStore[] = [];
afterEach(() => {
  while (sqliteStores.length) sqliteStores.pop()?.close();
});

const implementations: Array<[string, Factory]> = [
  ['memoryStore()', (options) => memoryStore(options).checkpoints],
  [
    'SqliteStore',
    (options) => {
      const store = new SqliteStore(':memory:', options);
      sqliteStores.push(store);
      return store.checkpoints;
    },
  ],
  [
    'LocalStorageCheckpointStore',
    (options) => {
      const { fs, path } = createFakeFs();
      return new LocalStorageCheckpointStore(new StorageService('hash', 'schema', fs, path, '/root'), options);
    },
  ],
];

const save = (store: CheckpointStore, sessionId: string, stepIndex: number, extra = {}) =>
  store.save(sessionId, makeCheckpoint({ sessionId, stepIndex, ...extra }));

describe.each(implementations)('CheckpointStore.history contract: %s', (_name, factory) => {
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

describe('getCheckpointHistory()', () => {
  it('reads the history of a store that keeps one', async () => {
    const store = memoryStore().checkpoints;
    await save(store, 's', 1);
    await save(store, 's', 2);
    expect((await getCheckpointHistory(store, 's'))?.map((entry) => entry.step)).toEqual([2, 1]);
    expect(await getCheckpointHistory(store, 's', { limit: 1 })).toHaveLength(1);
  });

  it('returns undefined for a store without history()', async () => {
    const plain: CheckpointStore = {
      save: async () => undefined,
      load: async () => null,
      delete: async () => undefined,
    };
    expect(await getCheckpointHistory(plain, 's')).toBeUndefined();
  });

  it('returns undefined for KVCheckpointStore, which keeps no history yet (LOU-D43.2)', async () => {
    const data = new Map<string, string>();
    const kv = new KVCheckpointStore({
      get: async (key) => data.get(key) ?? null,
      put: async (key, value) => void data.set(key, value),
      delete: async (key) => void data.delete(key),
    });
    await save(kv, 's', 1);
    expect(await getCheckpointHistory(kv, 's')).toBeUndefined();
  });
});
