import type { FileSystemAdapter, PathAdapter } from '../../storage/StorageService';

/**
 * A minimal in-memory fake of the Node fs/path modules, good enough to
 * exercise StorageService's real read/write/lock logic without touching
 * disk. Mirrors the mocking style already used in StorageService.test.ts
 * and ApprovalGate.test.ts.
 */
export function createFakeFs(): { fs: FileSystemAdapter; path: PathAdapter } {
  const files = new Map<string, string>();

  const fs: FileSystemAdapter = {
    existsSync: (p: string) => files.has(p),
    mkdirSync: () => undefined,
    writeFileSync: (p: string, data: string | Uint8Array) => {
      files.set(p, typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    },
    unlinkSync: (p: string) => {
      files.delete(p);
    },
    readFileSync: (p: string) => files.get(p) as any,
    rmSync: (p: string) => {
      files.delete(p);
    },
  };

  const path: PathAdapter = {
    join: (...parts: string[]) => parts.join('/'),
    resolve: (...parts: string[]) => parts.join('/'),
  };

  return { fs, path };
}
