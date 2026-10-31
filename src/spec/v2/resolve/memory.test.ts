import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { memoryKey } from '../../../memory/defineMemory';
import type { EmbeddingProvider } from '../../../memory/embeddings';
import type { StandardSchemaV1 } from '../../../utils/zodCompat';
import type { MemorySpec } from '../memory';
import { memoryFromSpec } from './memory';

const dirs: string[] = [];
const baseDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lousho-spec-memory-'));
  dirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A sqlite-vector slot keeps its database open; Windows then refuses to
      // delete it, so the temp dir is left for the OS.
    }
  }
});

const hasNodeSqlite = (() => {
  try {
    return (process.getBuiltinModule?.('node:sqlite') as { DatabaseSync?: unknown } | undefined)?.DatabaseSync !== undefined;
  } catch {
    return false;
  }
})();

const fakeEmbedder: EmbeddingProvider = { id: 'fake', embed: async (texts) => texts.map(() => [1, 0]) };

describe('memoryFromSpec', () => {
  it('compiles a minimal in-memory entry with the defineMemory defaults', async () => {
    const slot = await memoryFromSpec({ name: 'notes', scope: 'global', provider: { type: 'in-memory' } }, { baseDir: baseDir() });
    expect(slot.name).toBe('notes');
    expect(slot.scope).toBe('global');
    expect(slot.recall).toEqual({ onSessionStart: true, maxItems: 10, query: 'none' });
    expect(slot.expose).toEqual({ remember: true, recall: true, forget: false });
  });

  it('compiles { metadataKey } to a scope function keyed on run metadata', async () => {
    const slot = await memoryFromSpec(
      { name: 'notes', scope: { metadataKey: 'userId' }, provider: { type: 'in-memory' } },
      { baseDir: baseDir() }
    );
    expect(memoryKey(slot, { metadata: { userId: 'u1' } })).toBe('notes#userId:u1');
    expect(memoryKey(slot)).toBeUndefined();
    expect(memoryKey(slot, { metadata: { userId: 42 } })).toBeUndefined();
  });

  it('writes file provider items under <baseDir>/<dir>', async () => {
    const dir = baseDir();
    const slot = await memoryFromSpec(
      { name: 'notes', scope: 'global', provider: { type: 'file', dir: 'mem' } },
      { baseDir: dir }
    );
    await slot.provider.add('notes#global', { text: 'remember this' });
    expect(existsSync(path.join(dir, 'mem', 'notes%23global.json'))).toBe(true);
  });

  it.skipIf(!hasNodeSqlite)('compiles sqlite-vector through host.resolveEmbedder and stores items', async () => {
    const resolveEmbedder = async (id: string) => {
      expect(id).toBe('fake/embed');
      return fakeEmbedder;
    };
    const spec: MemorySpec = { name: 'notes', scope: 'global', provider: { type: 'sqlite-vector', embedder: 'fake/embed' } };
    const dir = baseDir();
    const slot = await memoryFromSpec(spec, { baseDir: dir, resolveEmbedder });
    expect(existsSync(path.join(dir, '.lousho', 'memory.db'))).toBe(true);
    const key = memoryKey(slot)!;
    await slot.provider.add(key, { text: 'a vector fact' });
    expect((await slot.provider.list(key)).map((item) => item.text)).toEqual(['a vector fact']);
  });

  it('rejects sqlite-vector when the host cannot build an embedder', async () => {
    const spec: MemorySpec = { name: 'notes', scope: 'global', provider: { type: 'sqlite-vector', embedder: 'fake/embed' } };
    await expect(memoryFromSpec(spec, { baseDir: baseDir() })).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_UNSUPPORTED',
      field: 'memory',
      message: expect.stringContaining("memory 'notes': sqlite-vector needs host.resolveEmbedder"),
    });
  });

  it('passes itemJsonSchema through host.toStandardSchema as slot.itemSchema', async () => {
    const standard: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'stub',
        validate: (value) => ({ value }),
        // defineMemory only accepts a Standard Schema that can render itself as JSON Schema.
        jsonSchema: { input: () => ({ type: 'object' }), output: () => ({ type: 'object' }) },
      } as StandardSchemaV1['~standard'],
    };
    const spec: MemorySpec = {
      name: 'facts',
      scope: 'global',
      provider: { type: 'in-memory' },
      itemJsonSchema: { type: 'object' },
      itemKey: ['topic'],
    };
    const slot = await memoryFromSpec(spec, { baseDir: baseDir(), toStandardSchema: () => standard });
    expect(slot.itemSchema).toBe(standard);
    expect(slot.itemKey).toEqual(['topic']);
  });

  it('rejects itemJsonSchema when the host has no JSON-Schema adapter', async () => {
    const spec: MemorySpec = {
      name: 'facts',
      scope: 'global',
      provider: { type: 'in-memory' },
      itemJsonSchema: { type: 'object' },
    };
    await expect(memoryFromSpec(spec, { baseDir: baseDir() })).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_UNSUPPORTED',
      field: 'memory',
      message: expect.stringContaining("memory 'facts': itemJsonSchema needs host.toStandardSchema"),
    });
  });
});
