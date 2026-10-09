/**
 * Eve MEM-F8: a lock file that serializes a load-modify-save of one file
 * across every writer - other provider instances in this process and other
 * processes sharing the directory - so concurrent writers never drop each
 * other's changes. Taking the lock is an exclusive create of `<file>.lock`
 * (`open(..., 'wx')`), which the filesystem makes atomic.
 */

import { open, rm, stat } from 'node:fs/promises';
import { SDKError } from '../execution/errors';
import { withFsRetry } from './fsRetry';

/** Options of {@link withFileLock}. */
export interface FileLockOptions {
  /** Give up waiting for the lock after this many ms, with `LOUSHO_STORAGE_FAILED`. Default 10 000. */
  timeoutMs?: number;
  /** A lock file older than this (ms) is taken to be left by a crashed writer and is removed. Default 30 000. */
  staleMs?: number;
}

/** Errors that mean "someone else holds or is releasing the lock - try again". */
const BUSY = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Age in ms of `file`'s last change, or `undefined` when it is gone. */
async function ageOf(file: string): Promise<number | undefined> {
  try {
    return Date.now() - (await stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Runs `task` while holding the lock file `lockPath`, waiting (with a short
 * backoff) while another writer holds it. The directory must exist. A lock
 * file older than `staleMs` is removed and taken over. Throws
 * `LOUSHO_STORAGE_FAILED` when the lock stays taken for `timeoutMs`.
 */
export async function withFileLock<T>(lockPath: string, task: () => Promise<T>, { timeoutMs = 10_000, staleMs = 30_000 }: FileLockOptions = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (let delay = 2; ; delay = Math.min(delay * 2, 50)) {
    try {
      await (await open(lockPath, 'wx')).close();
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !BUSY.has(code)) throw error;
      const age = await ageOf(lockPath);
      if (age !== undefined && age > staleMs) {
        await rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new SDKError(
          `Could not lock ${lockPath}: another writer held it for ${timeoutMs} ms. If no other process uses this directory, delete the lock file.`,
          'LOUSHO_STORAGE_FAILED',
          { cause: error }
        );
      }
      await sleep(delay);
    }
  }
  try {
    return await task();
  } finally {
    await withFsRetry(`unlock ${lockPath}`, () => rm(lockPath, { force: true })).catch(() => undefined);
  }
}
