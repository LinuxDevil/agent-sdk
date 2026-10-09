/**
 * Eve DUR-F13: Windows refuses to rename over, or read, a file that another
 * handle has open at that moment (a concurrent writer's rename, a reader, an
 * antivirus or indexer scan) with a transient `EPERM`, `EACCES` or `EBUSY`.
 * Two `fileStore()`s on one directory hit it under ordinary concurrency. The
 * file-backed stores retry those operations with a short backoff and report a
 * failure that outlasts it as `LOUSHO_STORAGE_FAILED`.
 */

import { readFile, rename } from 'node:fs/promises';
import { SDKError } from '../execution/errors';

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** Delays between attempts, in ms: about 1.3 s in all before giving up. */
const BACKOFF_MS = [5, 10, 20, 40, 80, 120, 200, 300, 500];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `operation`, retrying it while it fails with `EPERM`, `EACCES` or
 * `EBUSY`. When it still fails, throws `LOUSHO_STORAGE_FAILED` naming `what`,
 * with the last error as its `cause`; any other error is rethrown as it is.
 */
export async function withFsRetry<T>(what: string, operation: () => Promise<T>, backoff: readonly number[] = BACKOFF_MS): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !TRANSIENT.has(code)) throw error;
      if (attempt >= backoff.length) {
        throw new SDKError(
          `Could not ${what}: ${(error as Error).message} (still failing after ${backoff.length} retries; another process may hold the file open).`,
          'LOUSHO_STORAGE_FAILED',
          { cause: error }
        );
      }
      await sleep(backoff[attempt]);
    }
  }
}

/** `rename(from, to)` with {@link withFsRetry}. */
export function renameWithRetry(from: string, to: string): Promise<void> {
  return withFsRetry(`replace ${to}`, () => rename(from, to));
}

/** `readFile(file, 'utf8')` with {@link withFsRetry}. */
export function readFileWithRetry(file: string): Promise<string> {
  return withFsRetry(`read ${file}`, () => readFile(file, 'utf8'));
}
