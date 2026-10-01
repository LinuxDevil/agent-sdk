import { defineMemory, type DefineMemoryOptions, type MemorySlot } from '../memory/defineMemory';
import { loadDefaultExports } from './loadDefaultExports';

type MemoryFile = Omit<DefineMemoryOptions, 'name'> & { name?: string };

/** A slot from `defineMemory()`, or the same options without a `name`: an object with a `scope` and a `provider`. */
function isMemoryLike(value: unknown): value is MemoryFile {
  const slot = value as Partial<MemoryFile> | null;
  return typeof slot === 'object' && slot !== null && slot.scope !== undefined && typeof slot.provider === 'object' && slot.provider !== null;
}

/**
 * Loads every `memory/*.{ts,js,mjs,cjs,mts}` file under `dir` (sorted by file
 * name). Each file default-exports a memory slot: `defineMemory({ ... })`, or
 * the same options without a `name`. The slot name is the `name` it set, else
 * the file name without extension.
 */
export function loadMemory(dir: string): Promise<MemorySlot[]> {
  return loadDefaultExports(
    dir,
    'memory',
    'LOUSHY_MEMORY_INVALID',
    'a memory slot from defineMemory(), or an object with a scope and a provider.',
    isMemoryLike,
    (slot, stem) => defineMemory({ ...slot, name: slot.name ?? stem })
  );
}

/** Directory slots plus the caller's; on a name clash the caller's (override) slot wins. */
export function mergeMemory(
  fromDir: readonly MemorySlot[],
  overrides: readonly MemorySlot[] | undefined
): readonly MemorySlot[] | undefined {
  if (!overrides) return fromDir.length > 0 ? fromDir : undefined;
  const taken = new Set(overrides.map((s) => s.name));
  return [...fromDir.filter((s) => !taken.has(s.name)), ...overrides];
}
