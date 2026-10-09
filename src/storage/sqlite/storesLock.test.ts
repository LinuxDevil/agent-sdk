/**
 * Eve E14 (DUR-F14 follow-up): the SqliteStore stores write through
 * `transactionAsync()`, so a write that meets another process's lock waits
 * with backoff (the event loop keeps running) and succeeds once the lock
 * clears, instead of failing at once with LOUSHO_STORAGE_BUSY.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './index';
import { loadDatabaseSync } from './driver';
import { makeCheckpoint, makePending, makeSnapshot } from './__fixtures__/storeContracts';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanup.splice(0).reverse()) done();
});

function openStore(): { store: SqliteStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-stores-lock-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const path = join(dir, 'agent.db');
  const store = new SqliteStore(path);
  cleanup.push(() => store.close());
  return { store, path };
}

/** Another connection takes the write lock of `path` and holds it for 200 ms. */
function lockFor200ms(path: string): void {
  const holder = new (loadDatabaseSync())(path);
  holder.exec('BEGIN IMMEDIATE');
  const release = () => {
    if (!holder.isOpen) return;
    holder.exec('COMMIT');
    holder.close();
  };
  const timer = setTimeout(release, 200);
  cleanup.push(() => (clearTimeout(timer), release()));
}

describe("SqliteStore writes wait out another connection's lock (Eve E14)", () => {
  it('checkpoints.save', async () => {
    const { store, path } = openStore();
    lockFor200ms(path);
    await store.checkpoints.save('s', makeCheckpoint({ sessionId: 's' }));
    expect(await store.checkpoints.load('s')).not.toBeNull();
  });

  it('approvals.save', async () => {
    const { store, path } = openStore();
    const pending = makePending('ap-1');
    lockFor200ms(path);
    await store.approvals.save(pending, makeSnapshot(pending));
    expect(await store.approvals.load('ap-1')).not.toBeNull();
  });

  it('approvals.resolve and checkpoints.delete', async () => {
    const { store, path } = openStore();
    const pending = makePending('ap-1');
    await store.approvals.save(pending, makeSnapshot(pending));
    await store.checkpoints.save('s', makeCheckpoint({ sessionId: 's' }));
    lockFor200ms(path);
    const [resolved] = await Promise.all([store.approvals.resolve('ap-1'), store.checkpoints.delete('s')]);
    expect(resolved?.pending.id).toBe('ap-1');
    expect(await store.checkpoints.load('s')).toBeNull();
  });
});
