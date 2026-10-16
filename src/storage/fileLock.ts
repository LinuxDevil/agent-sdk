/**
 * A lock file that serializes a load-modify-save of one file
 * across every writer - other provider instances in this process and other
 * processes sharing the directory - so concurrent writers never drop each
 * other's changes. Taking the lock is an exclusive create of `<file>.lock`
 * (`open(..., 'wx')`), which the filesystem makes atomic.
 *
 * A lock left by a crashed writer (older than `staleMs`) is taken over, and
 * the takeover itself is serialized: a writer must first hold `<lock>.break`
 * (another exclusive create) and see the same stale lock file again before it
 * removes it. Without that, two writers that both saw the stale lock could each
 * remove it, the second one deleting the fresh lock the first had just taken,
 * and both would hold the lock. A holder refreshes its lock's mtime while it
 * runs, so a slow writer is never mistaken for a crashed one, and it only
 * removes its own lock file when it releases.
 */

import { open, rm, stat, utimes } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SDKError } from '../execution/errors';
import { withFsRetry } from './fsRetry';

/** Options of {@link withFileLock}. */
export interface FileLockOptions {
  /** Give up waiting for the lock after this many ms, with `LOUSHO_STORAGE_FAILED`. Default 10 000. */
  timeoutMs?: number;
  /** A lock file older than this (ms) is taken to be left by a crashed writer and is removed. Default 30 000. */
  staleMs?: number;
}

/** Internal options: the error a lock that stays taken fails with. */
interface LockFailure {
  busyCode?: 'LOUSHO_STORAGE_FAILED' | 'LOUSHO_STORAGE_BUSY';
}

/** Errors that mean "someone else holds or is releasing the lock - try again". */
const BUSY = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `file`'s identity (inode and mtime), or `undefined` when it is gone. */
async function identityOf(file: string): Promise<{ ino: number; mtimeMs: number } | undefined> {
  try {
    const { ino, mtimeMs } = await stat(file);
    return { ino, mtimeMs };
  } catch {
    return undefined;
  }
}

/** Exclusive-creates `file` with `content`; `false` when another writer has it. */
async function createExclusive(file: string, content: string): Promise<boolean> {
  try {
    const handle = await open(file, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === undefined || !BUSY.has(code)) throw error;
    return false;
  }
}

/**
 * Removes the stale lock `lockPath` (last seen as `seen`) unless another writer
 * got to it first: only the holder of `<lock>.break` may remove it, and only
 * while it is still the file that was seen.
 */
async function breakStaleLock(lockPath: string, seen: { ino: number; mtimeMs: number }, staleMs: number): Promise<void> {
  const breaker = `${lockPath}.break`;
  if (!(await createExclusive(breaker, String(process.pid)))) {
    // A breaker that crashed mid-break left this file; it only lives for a few ms otherwise.
    const left = await identityOf(breaker);
    if (left && Date.now() - left.mtimeMs > staleMs) await rm(breaker, { force: true }).catch(() => undefined);
    return;
  }
  try {
    const now = await identityOf(lockPath);
    if (now && now.ino === seen.ino && now.mtimeMs === seen.mtimeMs) await rm(lockPath, { force: true });
  } finally {
    await rm(breaker, { force: true }).catch(() => undefined);
  }
}

/**
 * Takes the lock file `lockPath`, waiting (with a short backoff) while another
 * writer holds it, and returns its release function. The directory must exist.
 */
async function acquireFileLock(lockPath: string, timeoutMs: number, staleMs: number, busyCode: string): Promise<() => Promise<void>> {
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  for (let delay = 2; ; delay = Math.min(delay * 2, 50)) {
    if (await createExclusive(lockPath, token)) break;
    const held = await identityOf(lockPath);
    if (held && Date.now() - held.mtimeMs > staleMs) {
      await breakStaleLock(lockPath, held, staleMs);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new SDKError(
        `Could not lock ${lockPath}: another writer held it for ${timeoutMs} ms. If no other process uses this directory, delete the lock file.`,
        busyCode as 'LOUSHO_STORAGE_FAILED'
      );
    }
    await sleep(delay);
  }
  const mine = await identityOf(lockPath);
  // Keep the lock fresh while the task runs, so a slow writer is not taken for a crashed one.
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(lockPath, now, now).catch(() => undefined);
  }, Math.max(10, Math.floor(staleMs / 3)));
  (heartbeat as { unref?: () => void }).unref?.();
  return async () => {
    clearInterval(heartbeat);
    // Only our own lock file: one taken over after all (and re-created by another writer) is not ours to remove.
    const now = await identityOf(lockPath);
    if (!now || (mine && now.ino !== mine.ino)) return;
    await withFsRetry(`unlock ${lockPath}`, () => rm(lockPath, { force: true })).catch(() => undefined);
  };
}

/**
 * Runs `task` while holding the lock file `lockPath`, waiting (with a short
 * backoff) while another writer holds it. The directory must exist. A lock
 * file older than `staleMs` is removed and taken over (see the module
 * comment). Throws `LOUSHO_STORAGE_FAILED` when the lock stays taken for `timeoutMs`.
 */
export async function withFileLock<T>(
  lockPath: string,
  task: () => Promise<T>,
  { timeoutMs = 10_000, staleMs = 30_000, busyCode = 'LOUSHO_STORAGE_FAILED' }: FileLockOptions & LockFailure = {}
): Promise<T> {
  const release = await acquireFileLock(lockPath, timeoutMs, staleMs, busyCode);
  try {
    return await task();
  } finally {
    await release();
  }
}
