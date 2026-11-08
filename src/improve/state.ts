import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError } from '../execution/errors';
import { writeFileAtomic } from '../storage/atomicFile';
import { withFileLock } from '../storage/fileLock';

const STATE_FILE = path.join('.lousho', 'state.json');
const STATE_LOCK = path.join('.lousho', 'state.lock');

export function readState<T extends object>(dir: string): Partial<T> {
  const file = path.join(dir, STATE_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ConfigurationError(`${file} is not a JSON object; fix or delete it before the self-healing loop runs.`, 'state', 'LOUSHO_CONFIG_INVALID');
  return parsed as Partial<T>;
}

export async function updateState<T extends object>(dir: string, change: Partial<T> | ((current: Partial<T>) => Partial<T>)): Promise<Partial<T>> {
  mkdirSync(path.join(dir, '.lousho'), { recursive: true });
  return withFileLock(path.join(dir, STATE_LOCK), async () => {
    const current = readState<T>(dir);
    const next = { ...current, ...(typeof change === 'function' ? change(current) : change) };
    await writeFileAtomic(path.join(dir, STATE_FILE), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}
