/**
 * N15: sqliteVectorMemory - the shared provider contract in rank mode,
 * persistence of vectors across reopening, migration of a database from
 * before `memory_vectors`, and that `sqliteMemory` / `memory_items` are untouched.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeMemoryProviderContract } from '../../memory/providerContract';
import { hashEmbedder } from '../../testing';
import { SqliteStore, sqliteMemory, sqliteVectorMemory } from './index';
import { MIGRATIONS, migrate } from './migrations';
import { loadDatabaseSync } from './driver';

const dirs: string[] = [];
const stores: SqliteStore[] = [];
const embedder = hashEmbedder();

const open = (file: string): SqliteStore => {
  const store = new SqliteStore(file);
  stores.push(store);
  return store;
};
const tempFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-sqlite-vector-'));
  dirs.push(dir);
  return join(dir, 'agent.db');
};
const texts = async (list: Promise<{ text: string }[]>) => (await list).map((i) => i.text);

afterEach(() => {
  // Close before deleting: Windows keeps open SQLite files locked.
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describeMemoryProviderContract('sqliteVectorMemory', (options) => sqliteVectorMemory(open(tempFile()), { embedder, ...options }), { query: 'rank' });

describe('sqliteVectorMemory', () => {
  it('keeps vectors and metadata across two SqliteStore instances on the same file', async () => {
    const file = tempFile();
    const first = open(file);
    const memory = sqliteVectorMemory(first, { embedder });
    const added = await memory.add('k', { text: 'Sam is vegetarian', metadata: { source: 'chat' } });
    await memory.add('k', { text: 'The office is in Oslo' });
    first.close();

    const second = sqliteVectorMemory(open(file), { embedder });
    const found = await second.list('k', { query: 'vegetarian food' });
    expect(found.map((i) => i.text)).toEqual(['Sam is vegetarian']);
    expect(found[0]).toMatchObject({ id: added.id, createdAt: added.createdAt, metadata: { source: 'chat', score: expect.any(Number) } });
    expect(found[0].metadata?.score).toBeCloseTo(0.5, 3);
  });

  it('skips items of another embedder and reindex() fixes them, in the file', async () => {
    const file = tempFile();
    const old = sqliteVectorMemory(open(file), { embedder: hashEmbedder({ dimensions: 64 }) });
    await old.add('a', { text: 'Sam is vegetarian' });
    await old.add('b', { text: 'Prefers dark mode' });

    const memory = sqliteVectorMemory(open(file), { embedder });
    expect(await texts(memory.list('a', { query: 'vegetarian' }))).toEqual([]);
    expect(await texts(memory.list('a'))).toEqual(['Sam is vegetarian']);
    expect(await memory.reindex('a')).toBe(1);
    expect(await texts(memory.list('a', { query: 'vegetarian' }))).toEqual(['Sam is vegetarian']);
    expect(await memory.reindex()).toBe(1);
    expect(await texts(memory.list('b', { query: 'dark mode' }))).toEqual(['Prefers dark mode']);
  });

  it('drops the oldest beyond maxItems and keeps scope keys apart', async () => {
    const memory = sqliteVectorMemory(open(tempFile()), { embedder, maxItems: 2 });
    for (const text of ['one', 'two', 'three']) await memory.add('a', { text });
    await memory.add('b', { text: 'three' });
    expect(await texts(memory.list('a'))).toEqual(['three', 'two']);
    expect(await texts(memory.list('b', { query: 'three' }))).toEqual(['three']);
  });

  it('does not store an item whose embedding fails', async () => {
    const store = open(tempFile());
    const memory = sqliteVectorMemory(store, { embedder: { id: 'down', embed: () => Promise.reject(new Error('quota')) } });
    await expect(memory.add('k', { text: 'x' })).rejects.toThrow('quota');
    expect(await memory.list('k')).toEqual([]);
  });

  it('adds the table to a database from before it, keeping sessions and memory_items', async () => {
    const file = tempFile();
    const raw = new (loadDatabaseSync())(file);
    migrate(raw, MIGRATIONS.slice(0, 3));
    raw.exec("INSERT INTO sessions (id, payload, created_at, updated_at) VALUES ('s1', '[]', 1, 1)");
    raw.close();

    const store = open(file);
    expect(await store.sessions.load('s1')).toEqual([]);
    const plain = sqliteMemory(store);
    await plain.add('global', { text: 'hello' });
    const vectors = sqliteVectorMemory(store, { embedder });
    await vectors.add('global', { text: 'hello there' });

    expect((await plain.list('global')).map((i) => i.text)).toEqual(['hello']);
    expect(await texts(vectors.list('global'))).toEqual(['hello there']);
    const check = new (loadDatabaseSync())(file);
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
    expect(check.prepare('SELECT count(*) AS n FROM memory_items').get()).toEqual({ n: 1 });
    expect(check.prepare('SELECT embedder, dimensions FROM memory_vectors').get()).toEqual({ embedder: 'hash:256', dimensions: 256 });
    check.close();
  });
});
