import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../storage/atomicFile';
import { withFileLock } from '../storage/fileLock';

export interface WatcherEntry {
  agent: string;
  dir: string;
  owner: string;
  since: string;
}

function readEntries(file: string): WatcherEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const list = (parsed as { watchers?: unknown } | null)?.watchers;
    return Array.isArray(list) ? list.filter((item): item is WatcherEntry => typeof item?.agent === 'string' && typeof item?.dir === 'string' && typeof item?.owner === 'string') : [];
  } catch {
    return [];
  }
}

async function update(file: string, change: (entries: WatcherEntry[]) => WatcherEntry[]): Promise<void> {
  mkdirSync(path.dirname(file), { recursive: true });
  await withFileLock(`${file}.lock`, async () => {
    await writeFileAtomic(file, `${JSON.stringify({ watchers: change(readEntries(file)) }, null, 2)}\n`);
  });
}

export function readWatchers(file: string): WatcherEntry[] {
  return readEntries(file);
}

export async function registerWatcher(file: string, entry: Omit<WatcherEntry, 'since'>): Promise<void> {
  await update(file, (entries) => [...entries.filter((item) => item.owner !== entry.owner), { ...entry, dir: path.resolve(entry.dir), since: new Date().toISOString() }]);
}

export async function unregisterWatcher(file: string, owner: string): Promise<void> {
  await update(file, (entries) => entries.filter((item) => item.owner !== owner));
}
