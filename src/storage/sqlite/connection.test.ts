/**
 * Eve DUR-F14: lock contention must not freeze the event loop for seconds and
 * must surface as the coded LOUSHO_STORAGE_BUSY, not a raw ERR_SQLITE_ERROR.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connection } from './connection';
import { loadDatabaseSync } from './driver';

const dirs: string[] = [];
const conns: Connection[] = [];

afterEach(() => {
  for (const c of conns.splice(0)) c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function open(name: string): { conn: Connection; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-conn-'));
  dirs.push(dir);
  const path = join(dir, name);
  const conn = Connection.open(path);
  conns.push(conn);
  return { conn, path };
}

function lockedByAnotherConnection() {
  const { conn, path } = open('a.db');
  const holder = new (loadDatabaseSync())(path);
  holder.exec('BEGIN IMMEDIATE');
  return { conn, holder };
}

describe('Connection lock contention (Eve DUR-F14)', () => {
  it('transaction() fails fast with LOUSHO_STORAGE_BUSY instead of blocking for seconds', () => {
    const { conn, holder } = lockedByAnotherConnection();
    const start = Date.now();
    let caught: { code?: string; cause?: unknown } | undefined;
    try {
      conn.transaction(() => 1);
    } catch (e) {
      caught = e as { code?: string };
    }
    const elapsed = Date.now() - start;
    holder.close();
    expect(caught?.code).toBe('LOUSHO_STORAGE_BUSY');
    expect(caught?.cause).toBeDefined();
    expect(elapsed).toBeLessThan(1000);
  });

  it('transactionAsync() waits without blocking the event loop and succeeds once the lock clears', async () => {
    const { conn, holder } = lockedByAnotherConnection();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    setTimeout(() => {
      holder.exec('COMMIT');
      holder.close();
    }, 300);
    const result = await conn.transactionAsync(() => 'done');
    clearInterval(timer);
    expect(result).toBe('done');
    expect(ticks).toBeGreaterThan(5);
  });

  it('does not map non-lock errors', () => {
    const { conn } = open('b.db');
    expect(() =>
      conn.transaction(() => {
        throw new Error('boom');
      })
    ).toThrow('boom');
  });
});
