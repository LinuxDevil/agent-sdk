/**
 * LOU-D43: one contract suite for `CheckpointStore.history()`, run against
 * every store that implements it (the in-memory store, `SqliteStore`,
 * `LocalStorageCheckpointStore`, `KVCheckpointStore` and `fileStore()`), plus the `getCheckpointHistory()` helper on
 * stores that do not.
 */
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getCheckpointHistory,
  LocalStorageCheckpointStore,
  type CheckpointStore,
} from './checkpoint';
import { StorageService } from '../storage/StorageService';
import { memoryStore } from '../storage/agentStore';
import { fileStore } from '../storage/fileStore';
import { SqliteStore } from '../storage/sqlite';
import { KVCheckpointStore } from '../deploy/kvCheckpointStore';
import { createFakeFs } from './__fixtures__/fakeFs';
import { makeCheckpoint } from '../storage/sqlite/__fixtures__/storeContracts';
import { describeCheckpointHistoryContract, type CheckpointHistoryStoreFactory } from './__fixtures__/checkpointHistoryContract';

const sqliteStores: SqliteStore[] = [];
afterEach(() => {
  while (sqliteStores.length) sqliteStores.pop()?.close();
});

// fileStore() writes 55 checkpoints in one test; real files are slow on a loaded Windows machine.
vi.setConfig({ testTimeout: 20_000 });

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const implementations:Array<[string, CheckpointHistoryStoreFactory]> = [
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
    'KVCheckpointStore',
    (options) => {
      const data = new Map<string, string>();
      const kv = { get: async (key: string) => data.get(key) ?? null, put: async (key: string, value: string) => void data.set(key, value), delete: async (key: string) => void data.delete(key) };
      return new KVCheckpointStore(kv, undefined, undefined, options);
    },
  ],
  [
    'fileStore()',
    (options) => {
      const dir = mkdtempSync(join(tmpdir(), 'lousho-history-'));
      tempDirs.push(dir);
      return fileStore(dir, options).checkpoints;
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

for (const [name, factory] of implementations) describeCheckpointHistoryContract(name, factory);

const save = (store: CheckpointStore, sessionId: string, stepIndex: number) =>
  store.save(sessionId, makeCheckpoint({ sessionId, stepIndex }));

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
});
