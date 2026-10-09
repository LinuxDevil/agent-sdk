import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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

describe('withFileLock (Eve MEM-F8)', () => {
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

  it('gives up with LOUSHO_STORAGE_FAILED while a live lock outlasts timeoutMs', async () => {
    const lock = await lockIn();
    await writeFile(lock, '');
    await expect(withFileLock(lock, async () => 'never', { timeoutMs: 30 })).rejects.toMatchObject({ code: 'LOUSHO_STORAGE_FAILED' });
  });
});
