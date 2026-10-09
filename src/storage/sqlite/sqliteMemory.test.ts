/**
 * LOU-W6.2: sqliteMemory - the shared provider contract, persistence across
 * store instances, migration of an older database, and an agent that recalls
 * in one session what it remembered in another.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../../createAgent';
import { defineMemory } from '../../memory';
import { describeMemoryProviderContract } from '../../memory/providerContract';
import { mockModel, type MockRequest } from '../../testing';
import { SqliteStore, sqliteMemory } from './index';
import { MIGRATIONS, migrate } from './migrations';
import { loadDatabaseSync } from './driver';

const dirs: string[] = [];
const stores: SqliteStore[] = [];

const open = (file: string): SqliteStore => {
  const store = new SqliteStore(file);
  stores.push(store);
  return store;
};
const tempFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-sqlite-memory-'));
  dirs.push(dir);
  return join(dir, 'agent.db');
};

afterEach(() => {
  // Close before deleting: Windows keeps open SQLite files locked.
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describeMemoryProviderContract('sqliteMemory', (options) => sqliteMemory(open(tempFile()), options));

describe('sqliteMemory', () => {
  it('keeps every item when two providers on one store add to one key at once (Eve MEM-F8)', async () => {
    const store = open(tempFile());
    const a = sqliteMemory(store);
    const b = sqliteMemory(store);
    const texts = Array.from({ length: 10 }, (_, i) => [`a${i}`, `b${i}`]).flat();
    await Promise.all(texts.map((text) => (text.startsWith('a') ? a : b).add('notes#global', { text })));
    expect((await a.list('notes#global')).map((item) => item.text).sort()).toEqual(texts.slice().sort());
  });

  it('persists across two SqliteStore instances on the same file', async () => {
    const file = tempFile();
    const first = open(file);
    const added = await sqliteMemory(first).add('session:a', { text: 'likes tea', metadata: { source: 'test' } });
    first.close();

    const second = open(file);
    expect(await sqliteMemory(second).list('session:a')).toEqual([added]);
  });

  it('adds the table to a database from before memory, keeping its sessions', async () => {
    const file = tempFile();
    const raw = new (loadDatabaseSync())(file);
    migrate(raw, MIGRATIONS.slice(0, 2));
    raw.exec("INSERT INTO sessions (id, payload, created_at, updated_at) VALUES ('s1', '[]', 1, 1)");
    raw.close();

    const store = open(file);
    expect(await store.sessions.load('s1')).toEqual([]);
    const provider = sqliteMemory(store);
    await provider.add('global', { text: 'hello' });
    expect((await provider.list('global')).map((i) => i.text)).toEqual(['hello']);
  });

  it('lets an agent recall in one session what it remembered in another', async () => {
    const file = tempFile();
    const store = open(file);
    const notes = defineMemory({ name: 'notes', scope: 'global', provider: sqliteMemory(store) });
    const model = mockModel([
      { toolCalls: [{ name: 'remember_notes', args: { text: 'prefers green tea' } }] },
      'noted',
      'you prefer green tea',
    ]);
    const agent = createAgent({ provider: model, store, memory: [notes] });

    await agent.session({ id: 'one' }).send('remember that I prefer green tea');
    await agent.session({ id: 'two' }).send('what do I prefer?');
    const system = (call: MockRequest | undefined) => String(call?.messages.find((m) => m.role === 'system')?.content);
    expect(system(model.lastCall)).toContain('<memory name="notes">\n- prefers green tea\n</memory>');
  });
});
