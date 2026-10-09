/**
 * LOU-W5: SqliteStore - contract suites, persistence, migration, prune,
 * multi-instance access, error handling and an approval pause/resume that
 * crosses a close/reopen.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Vite 5 cannot resolve the bare 'node:sqlite' builtin; load it the way the library does.
const DatabaseSync = loadDatabaseSync();
import { SqliteStore } from './index';
import { migrate, MIGRATIONS } from './migrations';
import { loadDatabaseSync } from './driver';
import {
  describeApprovalStoreContract,
  describeCheckpointStoreContract,
  describeSessionStoreContract,
  makeCheckpoint,
  makePending,
  makeSnapshot,
} from './__fixtures__/storeContracts';
import { MemorySessionStore, FileSessionStore, decodeBytes, encodeBytes } from '../../session/sessionStore';
import type { Checkpoint, CheckpointStore } from '../../execution/checkpoint';
import type { ApprovalStore, ResolvedApproval } from '../../execution/ApprovalGate';
import { AgentExecutor } from '../../execution/AgentExecutor';
import { InMemoryApprovalStore } from '../../execution/InMemoryApprovalStore';
import { memoryStore } from '../agentStore';
import { resumeAfterApproval } from '../../execution/resume';
import { ToolRegistry } from '../../tools';
import { AgentBuilder } from '../../core';
import { mockModel } from '../../testing';

const tempDirs: string[] = [];
const stores: SqliteStore[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-sqlite-'));
  tempDirs.push(dir);
  return dir;
}

function open(path: string): SqliteStore {
  const store = new SqliteStore(path);
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (tempDirs.length) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function inMemoryCheckpointStore(): CheckpointStore {
  const map = new Map<string, string>();
  return {
    async save(id, checkpoint) {
      map.set(id, JSON.stringify(checkpoint, encodeBytes));
    },
    async load(id) {
      const raw = map.get(id);
      return raw === undefined ? null : (JSON.parse(raw, decodeBytes) as Checkpoint);
    },
    async delete(id) {
      map.delete(id);
    },
  };
}

function inMemoryApprovalStore(): ApprovalStore {
  const map = new Map<string, string>();
  return {
    async save(pending, snapshot) {
      map.set(pending.id, JSON.stringify({ pending, snapshot }, encodeBytes));
    },
    async load(id) {
      const raw = map.get(id);
      return raw === undefined ? null : (JSON.parse(raw, decodeBytes) as ResolvedApproval);
    },
    async resolve(id) {
      const raw = map.get(id);
      if (raw === undefined) return null;
      map.delete(id);
      return JSON.parse(raw, decodeBytes) as ResolvedApproval;
    },
  };
}

describeSessionStoreContract('MemorySessionStore', () => new MemorySessionStore());
describeSessionStoreContract('FileSessionStore', () => new FileSessionStore(tempDir()));
describeSessionStoreContract('SqliteStore.sessions', () => open(':memory:').sessions);
describeCheckpointStoreContract('in-memory', inMemoryCheckpointStore);
describeCheckpointStoreContract('SqliteStore.checkpoints', () => open(':memory:').checkpoints);
describeCheckpointStoreContract('memoryStore().checkpoints', () => memoryStore().checkpoints);
describeApprovalStoreContract('in-memory', inMemoryApprovalStore);
describeApprovalStoreContract('InMemoryApprovalStore', () => new InMemoryApprovalStore());
describeApprovalStoreContract('SqliteStore.approvals', () => open(':memory:').approvals);

describe('SqliteStore persistence', () => {
  it('keeps everything across close and reopen of a file', async () => {
    const file = join(tempDir(), 'agent.db');
    const first = new SqliteStore(file);
    await first.sessions.save('s1', [{ role: 'user', content: 'remember me' }]);
    await first.checkpoints.save('run-1', makeCheckpoint());
    const pending = makePending('ap-1');
    await first.approvals.save(pending, makeSnapshot(pending));
    first.close();

    const second = open(file);
    expect(await second.sessions.load('s1')).toEqual([{ role: 'user', content: 'remember me' }]);
    expect(await second.checkpoints.load('run-1')).toEqual(makeCheckpoint());
    expect((await second.approvals.resolve('ap-1'))?.pending).toEqual(pending);
  });

  it('creates a missing directory and uses WAL mode', () => {
    const file = join(tempDir(), 'nested', 'deeper', 'agent.db');
    const store = open(file);
    expect(existsSync(file)).toBe(true);
    expect(store.path).toBe(file);
    const raw = new DatabaseSync(file);
    expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    raw.close();
  });
});

describe('SqliteStore migrations', () => {
  it('upgrades a v0 (empty) database to the current version', async () => {
    const file = join(tempDir(), 'v0.db');
    const raw = new DatabaseSync(file);
    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
    raw.close();

    const store = open(file);
    await store.sessions.save('s', []);
    const check = new DatabaseSync(file);
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
    check.close();
  });

  it('applies only the missing steps, and rolls back a failing one', () => {
    const db = new DatabaseSync(':memory:');
    const steps = ['CREATE TABLE a (x INTEGER)', 'CREATE TABLE b (y INTEGER)'];
    expect(migrate(db, steps.slice(0, 1))).toBe(1);
    expect(migrate(db, steps)).toBe(2);
    const broken = [...steps, 'CREATE TABLE c (z INTEGER); THIS IS NOT SQL'];
    expect(() => migrate(db, broken)).toThrow();
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'c'").get()).toBeUndefined();
    db.close();
  });

  it('opens a file written before the checkpoint history existed (LOU-D43)', async () => {
    const file = join(tempDir(), 'old.db');
    const raw = new DatabaseSync(file);
    expect(migrate(raw, MIGRATIONS.slice(0, 1))).toBe(1);
    raw
      .prepare('INSERT INTO checkpoints (session_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('legacy', JSON.stringify(makeCheckpoint({ stepIndex: 5 })), 1, 1);
    raw.close();

    const store = open(file);
    expect((await store.checkpoints.load('legacy'))?.stepIndex).toBe(5);
    expect(await store.checkpoints.history?.('legacy')).toEqual([]); // saved before history existed
    await store.checkpoints.save('legacy', makeCheckpoint({ stepIndex: 6 }));
    expect((await store.checkpoints.history?.('legacy'))?.map((entry) => entry.step)).toEqual([6]);
    const check = new DatabaseSync(file);
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
    check.close();
  });

  it('refuses a database written by a newer version', () => {
    const file = join(tempDir(), 'future.db');
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA user_version = 999');
    raw.close();
    expect(() => new SqliteStore(file)).toThrow(/newer than this library supports/);
  });
});

describe('SqliteStore.prune', () => {
  it('deletes stale sessions, checkpoints and resolved approvals only', async () => {
    const file = join(tempDir(), 'prune.db');
    const store = open(file);
    await store.sessions.save('old', []);
    await store.sessions.save('fresh', []);
    await store.checkpoints.save('old', makeCheckpoint());
    await store.checkpoints.save('fresh', makeCheckpoint());
    for (const id of ['resolved-old', 'resolved-fresh', 'pending-old']) {
      const pending = makePending(id);
      await store.approvals.save(pending, makeSnapshot(pending));
    }
    await store.approvals.resolve('resolved-old');
    await store.approvals.resolve('resolved-fresh');

    const raw = new DatabaseSync(file);
    const age = 10 * 60 * 1000;
    raw.prepare('UPDATE sessions SET updated_at = updated_at - ? WHERE id = ?').run(age, 'old');
    raw.prepare('UPDATE checkpoints SET updated_at = updated_at - ? WHERE session_id = ?').run(age, 'old');
    raw.prepare('UPDATE approvals SET resolved_at = resolved_at - ? WHERE id = ?').run(age, 'resolved-old');
    raw.prepare('UPDATE approvals SET updated_at = updated_at - ? WHERE id = ?').run(age, 'pending-old');
    raw.close();

    expect(store.prune({ olderThanMs: 60 * 1000 })).toEqual({ sessions: 1, checkpoints: 1, approvals: 1, oauthPending: 0 });
    expect(await store.sessions.load('old')).toBeUndefined();
    expect(await store.sessions.load('fresh')).toEqual([]);
    expect(await store.checkpoints.load('old')).toBeNull();
    expect(await store.checkpoints.load('fresh')).not.toBeNull();
    expect(await store.approvals.resolve('resolved-old')).toBeNull();
    expect(await store.approvals.resolve('pending-old')).not.toBeNull();
    expect(store.prune({ olderThanMs: 60 * 1000 })).toEqual({ sessions: 0, checkpoints: 0, approvals: 0, oauthPending: 0 });
  });

  it('rejects a negative or non-finite age', () => {
    const store = open(':memory:');
    expect(() => store.prune({ olderThanMs: -1 })).toThrow(/olderThanMs/);
    expect(() => store.prune({ olderThanMs: Number.NaN })).toThrow(/olderThanMs/);
  });
});

describe('SqliteStore checkpoint history', () => {
  it('survives close and reopen, and honors historyLimit', async () => {
    const file = join(tempDir(), 'history.db');
    const first = new SqliteStore(file, { historyLimit: 2 });
    for (const stepIndex of [1, 2, 3]) await first.checkpoints.save('s', makeCheckpoint({ stepIndex }));
    first.close();

    const second = open(file);
    expect((await second.checkpoints.history?.('s'))?.map((entry) => entry.step)).toEqual([3, 2]);
  });

  it('prune() removes history entries older than the cutoff but keeps recent ones', async () => {
    const file = join(tempDir(), 'history-prune.db');
    const store = open(file);
    await store.checkpoints.save('s', makeCheckpoint({ stepIndex: 1 }));
    await store.checkpoints.save('s', makeCheckpoint({ stepIndex: 2 }));
    const raw = new DatabaseSync(file);
    raw.prepare('UPDATE checkpoint_history SET saved_at = saved_at - ? WHERE step = 1').run(10 * 60 * 1000);
    raw.close();

    store.prune({ olderThanMs: 60 * 1000 });
    expect((await store.checkpoints.history?.('s'))?.map((entry) => entry.step)).toEqual([2]);
  });
});

describe('SqliteStore sharing a file', () => {
  it('lets two instances see each other and resolve an approval only once', async () => {
    const file = join(tempDir(), 'shared.db');
    const a = open(file);
    const b = open(file);
    await a.sessions.save('s', [{ role: 'user', content: 'from a' }]);
    expect(await b.sessions.load('s')).toEqual([{ role: 'user', content: 'from a' }]);

    const pending = makePending('ap');
    await a.approvals.save(pending, makeSnapshot(pending));
    const results = await Promise.all([a.approvals.resolve('ap'), b.approvals.resolve('ap')]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('survives interleaved writes from two instances', async () => {
    const file = join(tempDir(), 'busy.db');
    const a = open(file);
    const b = open(file);
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      writes.push((i % 2 ? a : b).checkpoints.save(`run-${i}`, makeCheckpoint({ stepIndex: i })));
    }
    await Promise.all(writes);
    expect((await a.checkpoints.load('run-49'))?.stepIndex).toBe(49);
    expect((await b.checkpoints.load('run-0'))?.stepIndex).toBe(0);
  });

  it('migrates a fresh file once when two instances open it', () => {
    const file = join(tempDir(), 'race.db');
    const a = open(file);
    const b = open(file);
    expect(a.path).toBe(b.path);
  });
});

describe('SqliteStore errors', () => {
  it('names the path of a file that is not a SQLite database', () => {
    const file = join(tempDir(), 'garbage.db');
    writeFileSync(file, 'this is definitely not a sqlite database, just some text '.repeat(40));
    expect(() => new SqliteStore(file)).toThrow(new RegExp(`Could not open SQLite database at .*garbage\\.db`));
  });

  it('gives a clear error when used after close(), and close() is idempotent', async () => {
    const store = new SqliteStore(':memory:');
    const { sessions, checkpoints, approvals } = store;
    store.close();
    store.close();
    await expect(sessions.load('a')).rejects.toThrow(/is closed/);
    await expect(checkpoints.save('a', makeCheckpoint())).rejects.toThrow(/is closed/);
    await expect(approvals.resolve('a')).rejects.toThrow(/is closed/);
    expect(() => store.prune({ olderThanMs: 0 })).toThrow(/is closed/);
  });

  it('throws a clear Node-version error when node:sqlite is unavailable', () => {
    const original = process.getBuiltinModule;
    vi.spyOn(process, 'getBuiltinModule').mockImplementation(((id: string) =>
      id === 'node:sqlite' ? undefined : original(id)) as typeof process.getBuiltinModule);
    try {
      expect(() => new SqliteStore(':memory:')).toThrow(/needs the built-in 'node:sqlite' module \(Node >= 22/);
      expect(() => loadDatabaseSync()).toThrow(/Upgrade Node/);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('SqliteStore end to end', () => {
  it('resumes an approval after the store is closed and reopened', async () => {
    const file = join(tempDir(), 'e2e.db');
    const execute = vi.fn().mockResolvedValue({ charged: true });
    const registry = new ToolRegistry();
    registry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute } as never,
      needsApproval: true,
    });
    const agent = AgentBuilder.create()
      .setName('Test Agent')
      .addTool('chargeCard', { tool: 'chargeCard', options: {} })
      .build();
    const model = () => mockModel([{ toolCalls: [{ name: 'chargeCard', args: {} }] }, 'All done']);

    const first = new SqliteStore(file);
    const paused = await AgentExecutor.execute({
      agent,
      input: 'charge it',
      provider: model(),
      toolRegistry: registry,
      sessionId: 'run-1',
      checkpointStore: first.checkpoints,
      approvalStore: first.approvals,
    });
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(execute).not.toHaveBeenCalled();
    first.close();

    // "new process": fresh store instances, and a model that only has the post-approval turn.
    const second = open(file);
    const resumed = await resumeAfterApproval(
      { id: paused.approvalId as string, approved: true },
      second.approvals,
      registry,
      mockModel(['All done']),
      {},
      second.checkpoints
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(resumed.finishReason).toBe('stop');
    expect(await second.approvals.resolve(paused.approvalId as string)).toBeNull();
  });
});
