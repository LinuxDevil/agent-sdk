import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withFileLock } from './fileLock';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const lockIn = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lousho-file-lock-'));
  dirs.push(dir);
  return path.join(dir, 'x.json.lock');
};

describe('withFileLock', () => {
  it('runs tasks on one lock one at a time and removes the lock file after', async () => {
    const lock = await lockIn();
    let running = 0;
    let most = 0;
    const task = async () => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
    };
    await Promise.all(Array.from({ length: 6 }, () => withFileLock(lock, task)));
    expect(most).toBe(1);
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('releases the lock when the task throws', async () => {
    const lock = await lockIn();
    await expect(withFileLock(lock, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await withFileLock(lock, async () => 'next')).toBe('next');
  });

  it('takes over a stale lock for one writer only: concurrent writers that all saw it stale never hold the lock together', async () => {
    const lock = await lockIn();
    for (let trial = 0; trial < 10; trial++) {
      await writeFile(lock, 'crashed');
      const old = new Date(Date.now() - 60_000);
      await utimes(lock, old, old);
      let running = 0;
      let most = 0;
      const task = async () => {
        most = Math.max(most, ++running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running--;
      };
      await Promise.all(Array.from({ length: 8 }, () => withFileLock(lock, task, { staleMs: 1_000 })));
      expect(most).toBe(1);
    }
  }, 30_000);

  it('keeps a slow holder\'s lock fresh, so it is not taken over as stale while it runs', async () => {
    const lock = await lockIn();
    let overlapped = false;
    let inside = false;
    const slow = withFileLock(lock, async () => {
      inside = true;
      await new Promise((resolve) => setTimeout(resolve, 200));
      inside = false;
    }, { staleMs: 60 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await withFileLock(lock, async () => {
      if (inside) overlapped = true;
    }, { staleMs: 60 });
    await slow;
    expect(overlapped).toBe(false);
  });

  it('gives up with LOUSHO_STORAGE_FAILED while a live lock outlasts timeoutMs', async () => {
    const lock = await lockIn();
    await writeFile(lock, '');
    await expect(withFileLock(lock, async () => 'never', { timeoutMs: 30 })).rejects.toMatchObject({ code: 'LOUSHO_STORAGE_FAILED' });
  });
});
