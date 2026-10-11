/**
 * Durable file writes and file names shared by the file-backed stores
 * (`FileSessionStore`, `fileStore()`).
 *
 * `writeFileAtomic` writes to a temp file, flushes it to disk (`fsync`), renames
 * it over the target and flushes the directory, so neither a crashed process nor
 * a power loss leaves a half-written or empty file in place of the old one.
 *
 * `fileNameOf` is the case-safe name of an id (see `fileNames.ts`), shortened to
 * `<prefix>~<sha-256>` when it would be too long for a file name: every
 * uppercase letter doubles in the case-safe form and the temp-file suffix adds
 * about 50 characters, so a valid 128-character id could exceed the 255-byte
 * limit of common filesystems (`ENAMETOOLONG`). A name Windows reserves for a
 * device (`nul`, `com1.turn-0`) is shortened the same way. `~` never occurs in
 * a case-safe name, so a shortened name never collides with a plain one.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { caseSafeName } from './fileNames';
import { readFileWithRetry, renameWithRetry } from './fsRetry';

/** Longest case-safe name kept as it is; a temp file adds `.json.<pid>.<uuid>.tmp` (about 55 characters). */
const MAX_PLAIN_NAME = 180;

/** File names Windows reserves for devices, with or without an extension. */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

/** Marks a shortened name (see the module comment): `~<prefix>~<sha-256>`. */
export const HASHED_NAME_MARK = '~';

/** The file name (without extension) an id is stored under. */
export function fileNameOf(id: string): string {
  const safe = caseSafeName(id);
  // A name Windows reserves for a device (`nul.json` opens the null device there) is shortened like a long one.
  if (safe.length <= MAX_PLAIN_NAME && !WINDOWS_DEVICE_NAME.test(safe)) return safe;
  // Starting with the mark keeps a device name from being the part before the first dot.
  return `${HASHED_NAME_MARK}${safe.slice(0, 100)}${HASHED_NAME_MARK}${createHash('sha256').update(id).digest('hex').slice(0, 40)}`;
}

/** The file's text, or `undefined` when it does not exist. */
export async function readTextFile(file: string): Promise<string | undefined> {
  try {
    return await readFileWithRetry(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Flushes `dir` (the rename into it) to disk; a platform that cannot fsync a directory (Windows) is skipped. */
async function syncDirectory(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    // EISDIR / EPERM / EINVAL on platforms without directory fsync: the rename is still atomic.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Writes and flushes `content` to a new file `temp`. */
async function writeSynced(temp: string, content: string): Promise<void> {
  const handle = await open(temp, 'wx');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Writes `content` to `file` atomically and durably (see the module comment);
 * creates the directory when it is missing.
 */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    try {
      await writeSynced(temp, content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(dirname(file), { recursive: true });
      await writeSynced(temp, content);
    }
    await renameWithRetry(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await syncDirectory(dirname(file));
}
