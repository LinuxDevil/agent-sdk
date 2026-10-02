import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from '../utils/id';
import type { MemoryItem, MemoryProvider } from './defineMemory';
import { itemsProvider, type MemoryProviderOptions } from './providers';

/** Options for {@link fileMemory}. */
export interface FileMemoryOptions extends MemoryProviderOptions {
  /** Directory of the JSON files, one per scope key. Created on first write. */
  dir: string;
}

/**
 * Keeps memory in `dir`, one JSON file per scope key, written atomically
 * (temp file + rename).
 *
 * @example
 * ```ts
 * const prefs = defineMemory({ name: 'prefs', scope: 'session', provider: fileMemory({ dir: './.lousho/memory' }) });
 * ```
 */
export function fileMemory({ dir, ...options }: FileMemoryOptions): MemoryProvider {
  const fileOf = (key: string) => join(dir, `${encodeURIComponent(key)}.json`);
  return itemsProvider(
    {
      async load(key) {
        try {
          return JSON.parse(await readFile(fileOf(key), 'utf8')) as MemoryItem[];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw error;
        }
      },
      async save(key, items) {
        await mkdir(dir, { recursive: true });
        const temp = `${fileOf(key)}.${newId()}.tmp`;
        await writeFile(temp, JSON.stringify(items), 'utf8');
        await rename(temp, fileOf(key));
      },
    },
    options
  );
}
