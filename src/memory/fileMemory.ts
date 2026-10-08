import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from '../utils/id';
import { caseSafeName, findLegacyFile, removeLegacyFile } from '../storage/fileNames';
import type { MemoryItem, MemoryProvider } from './defineMemory';
import { itemsProvider, type MemoryProviderOptions } from './providers';

/** Options for {@link fileMemory}. */
export interface FileMemoryOptions extends MemoryProviderOptions {
  /** Directory of the JSON files, one per scope key. Created on first write. */
  dir: string;
}

/**
 * Keeps memory in `dir`, one JSON file per scope key, written atomically
 * (temp file + rename). The file name is the percent-encoded key with each
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
      return JSON.parse(await readFile(file, 'utf8')) as MemoryItem[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  return itemsProvider(
    {
      async load(key) {
        const items = await read(fileOf(key));
        if (items !== undefined) return items;
        const legacy = await findLegacyFile(dir, nameOf(key), encodeURIComponent(key));
        return (legacy !== undefined && (await read(legacy))) || [];
      },
      async save(key, items) {
        await mkdir(dir, { recursive: true });
        const temp = `${fileOf(key)}.${newId()}.tmp`;
        await writeFile(temp, JSON.stringify(items), 'utf8');
        await rename(temp, fileOf(key));
        await removeLegacyFile(dir, nameOf(key), encodeURIComponent(key));
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
