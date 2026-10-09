/**
 * Case-safe file names (Eve DUR-F7, MEM-F3), shared by every file-backed store
 * (`FileSessionStore`, `fileStore()`'s checkpoints and approvals, `fileMemory`).
 *
 * The default filesystems of Windows and macOS ignore case, so ids such as
 * `alice` and `Alice` used as file names would share one file: one user would
 * read another's transcript. Each uppercase letter is therefore written as `^`
 * plus the letter in lowercase (`Alice` -> `^alice`). `^` never occurs in a
 * session, checkpoint or approval id, nor in `encodeURIComponent` output, so
 * the encoding is reversible, and an id without uppercase letters keeps the
 * file name it had before.
 *
 * Files written before this encoding under a name with uppercase letters
 * (`Alice.json`) are still read, but only when the directory lists exactly that
 * name: a case-insensitive filesystem keeps the case of the id that last wrote
 * the file, so `alice`'s file is never read for `Alice`. The next save moves
 * such a file to its new name. Until then, on a case-insensitive filesystem,
 * a lowercase id (`alice`) still opens a legacy file of a case variant
 * (`Alice.json`), as it did before.
 */

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const UPPERCASE = /[A-Z]/g;

/** `Alice` -> `^alice`: a name that differs from every other id's name even when case is ignored. */
export function caseSafeName(name: string): string {
  return name.replace(UPPERCASE, (letter) => `^${letter.toLowerCase()}`);
}

/** Eve DUR-F15: the id a case-safe (or legacy) file name stands for: `^alice` -> `Alice`. */
export function idFromCaseSafeName(name: string): string {
  return name.replace(/\^([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * The path of `<legacyName>.json` in `dir` when it is a file written before
 * case-safe names: it differs from `<name>.json` and the directory lists exactly
 * that name (case included). `undefined` otherwise, or when `dir` is missing.
 */
export async function findLegacyFile(dir: string, name: string, legacyName: string): Promise<string | undefined> {
  if (legacyName === name) return undefined;
  const file = `${legacyName}.json`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return entries.includes(file) ? join(dir, file) : undefined;
}

/** After a save under the case-safe name, remove the legacy file it replaces (if any). */
export async function removeLegacyFile(dir: string, name: string, legacyName: string): Promise<void> {
  const legacy = await findLegacyFile(dir, name, legacyName);
  if (legacy) await rm(legacy, { force: true });
}
