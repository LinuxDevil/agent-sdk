import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileMemory } from './fileMemory';

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lousho-file-memory-'));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('fileMemory across instances (Eve MEM-F8)', () => {
  it('keeps every item when two providers on one directory add to one key at once', async () => {
    const dir = await tempDir();
    const a = fileMemory({ dir });
    const b = fileMemory({ dir });
    const texts = Array.from({ length: 15 }, (_, i) => [`a${i}`, `b${i}`]).flat();
    await Promise.all(texts.map((text) => (text.startsWith('a') ? a : b).add('notes#global', { text })));

    const stored = (await fileMemory({ dir }).list('notes#global')).map((item) => item.text);
    expect(stored.sort()).toEqual(texts.slice().sort());
    // No temp or lock file is left behind.
    expect(await readdir(dir)).toEqual(['notes%23global.json']);
  });

  it('takes over a lock file left behind by a crashed writer', async () => {
    const dir = await tempDir();
    const lock = path.join(dir, 'notes%23global.json.lock');
    await writeFile(lock, '');
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);

    await fileMemory({ dir }).add('notes#global', { text: 'after a crash' });
    expect((await fileMemory({ dir }).list('notes#global')).map((item) => item.text)).toEqual(['after a crash']);
  });
});
