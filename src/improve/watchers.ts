import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../storage/atomicFile';
import { withFileLock } from '../storage/fileLock';

export interface WatcherEntry {
  agent: string;
  dir: string;
  owner: string;
  pid: number;
  since: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isEntry(item: unknown): item is WatcherEntry {
  const entry = item as Partial<WatcherEntry> | null;
  return [entry?.agent, entry?.dir, entry?.owner].every((value) => typeof value === 'string');
}

function readEntries(file: string): WatcherEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const list = (parsed as { watchers?: unknown } | null)?.watchers;
    return Array.isArray(list) ? list.filter(isEntry) : [];
  } catch {
    return [];
  }
}

async function update(file: string, change: (entries: WatcherEntry[]) => WatcherEntry[]): Promise<void> {
  mkdirSync(path.dirname(file), { recursive: true });
  await withFileLock(`${file}.lock`, async () => {
    const live = readEntries(file).filter((item) => !Number.isInteger(item.pid) || alive(item.pid));
    await writeFileAtomic(file, `${JSON.stringify({ watchers: change(live) }, null, 2)}\n`);
  });
}

export function readWatchers(file: string): WatcherEntry[] {
  return readEntries(file);
}

export async function registerWatcher(file: string, entry: Omit<WatcherEntry, 'since' | 'pid'>): Promise<void> {
  const dir = path.resolve(entry.dir);
  await update(file, (entries) => [...entries.filter((item) => item.owner !== entry.owner && !(item.dir === dir && item.agent === entry.agent)), { ...entry, dir, pid: process.pid, since: new Date().toISOString() }]);
}

export async function unregisterWatcher(file: string, owner: string): Promise<void> {
  await update(file, (entries) => entries.filter((item) => item.owner !== owner));
}
