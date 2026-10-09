import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from '../utils/id';
import { caseSafeName, findLegacyFile, removeLegacyFile } from '../storage/fileNames';
import { withFileLock } from '../storage/fileLock';
import { readFileWithRetry, renameWithRetry } from '../storage/fsRetry';
import type { MemoryItem, MemoryProvider } from './defineMemory';
import { itemsProvider, type MemoryProviderOptions } from './providers';

/** Options for {@link fileMemory}. */
export interface FileMemoryOptions extends MemoryProviderOptions {
  /** Directory of the JSON files, one per scope key. Created on first write. */
  dir: string;
}

/**
 * Keeps memory in `dir`, one JSON file per scope key, written atomically
 * (temp file + rename). Each change holds a lock file (`<file>.lock`) while
 * it reads, changes and writes the key's file, so several `fileMemory`
 * providers - in this process or in other processes - can share `dir`
 * without losing each other's items (Eve MEM-F8). A lock left by a crashed
 * process is taken over after 30 s. Windows' transient `EPERM` / `EACCES` /
 * `EBUSY` on read and rename are retried. The file name is the percent-encoded key with each
 * uppercase letter written as `^` and the lowercase letter, so keys that differ
 * only in case (`user:Alice`, `user:alice`) get different files on Windows and
 * macOS too.
 *
 * @example
 * ```ts
 * const prefs = defineMemory({ name: 'prefs', scope: 'session', provider: fileMemory({ dir: './.lousho/memory' }) });
 * ```
 */
export function fileMemory({ dir, ...options }: FileMemoryOptions): MemoryProvider {
  const fileOf = (key: string) => join(dir, `${nameOf(key)}.json`);
  const read = async (file: string): Promise<MemoryItem[] | undefined> => {
    try {
      return JSON.parse(await readFileWithRetry(file)) as MemoryItem[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const load = async (key: string): Promise<MemoryItem[]> => {
    const items = await read(fileOf(key));
    if (items !== undefined) return items;
    const legacy = await findLegacyFile(dir, nameOf(key), encodeURIComponent(key));
    return (legacy !== undefined && (await read(legacy))) || [];
  };
  const save = async (key: string, items: MemoryItem[]): Promise<void> => {
    await mkdir(dir, { recursive: true });
    const temp = `${fileOf(key)}.${newId()}.tmp`;
    await writeFile(temp, JSON.stringify(items), 'utf8');
    try {
      await renameWithRetry(temp, fileOf(key));
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    await removeLegacyFile(dir, nameOf(key), encodeURIComponent(key));
  };
  return itemsProvider(
    {
      load,
      save,
      async update(key, change) {
        await mkdir(dir, { recursive: true });
        await withFileLock(`${fileOf(key)}.lock`, async () => save(key, change(await load(key))));
      },
    },
    options
  );
}

/**
 * The file name of a scope key: percent-encoded (with lowercase hex digits),
 * then case-safe, so `notes#user:Alice` -> `notes%23user%3a^alice`. A key of
 * lowercase letters, digits, `_`, `-` and `.` keeps its name from before.
 */
function nameOf(key: string): string {
  return caseSafeName(encodeURIComponent(key).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()));
}
