import { describe, it, expectTypeOf } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileSystemAdapter, PathAdapter } from './StorageService';

describe('StorageService adapters accept the real Node modules', () => {
  it('node:fs is assignable to FileSystemAdapter without a cast', () => {
    expectTypeOf(fs).toMatchTypeOf<FileSystemAdapter>();
    const adapter: FileSystemAdapter = fs;
    void adapter;
  });

  it('node:path is assignable to PathAdapter without a cast', () => {
    expectTypeOf(path).toMatchTypeOf<PathAdapter>();
  });

  it('a hand-written adapter with a plain string encoding still fits', () => {
    const custom = {
      existsSync: (_path: string) => true,
      mkdirSync: (_path: string, _options?: { recursive?: boolean }) => undefined,
      writeFileSync: (_path: string, _data: string | Uint8Array, _encoding?: string) => undefined,
      unlinkSync: (_path: string) => undefined,
      readFileSync: fs.readFileSync,
      rmSync: (_path: string) => undefined,
    };
    expectTypeOf(custom).toMatchTypeOf<FileSystemAdapter>();
  });
});
