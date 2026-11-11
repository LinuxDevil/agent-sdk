import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDatabaseSync, type SqlValue } from '../../storage/sqlite/driver';
import { postgresSqlClient, sqliteSqlClient, type PgPool, type PgQueryable, type SqlClient } from '../runtime/sql';
import { dbSource, postgresWorkspaceSource, sqliteWorkspaceSource } from './dbSource';
import { StaleRevisionError } from './errors';
import { revisionId } from './revision';
import type { SourceWriteOptions } from './types';
import { CONTRACT_FILES, sourceContract } from './__fixtures__/sourceContract';

const open: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const item of open.splice(0).reverse()) await item.close();
});

function tracked<T extends { close(): Promise<void> }>(item: T): T {
  open.push(item);
  return item;
}

interface PgCall {
  on: 'pool' | 'connection';
  text: string;
  values: unknown[];
}

type PgQuery = PgQueryable['query'];

function fakePool(): { pool: PgPool; calls: PgCall[]; released: () => number; onConnect: (hook: () => Promise<void>) => void } {
  const db = new (loadDatabaseSync())(':memory:');
  const calls: PgCall[] = [];
  const hooks: Array<() => Promise<void>> = [];
  let released = 0;
  const run =
    (on: PgCall['on']): PgQuery =>
    async (text, values = []) => {
      calls.push({ on, text, values });
      const sql = text.replace(/\$(\d+)/g, '?$1');
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) {
        db.exec(text);
        return { rows: [], rowCount: null };
      }
      const statement = db.prepare(sql);
      if (/^\s*SELECT/i.test(text)) return { rows: statement.all(...(values as SqlValue[])), rowCount: null };
      return { rows: [], rowCount: Number(statement.run(...(values as SqlValue[])).changes) };
    };
  const pool: PgPool = {
    query: run('pool'),
    async connect() {
      for (const hook of hooks.splice(0)) await hook();
      return { query: run('connection'), release: () => void released++ };
    },
    end: async () => db.close(),
  };
  return { pool, calls, released: () => released, onConnect: (hook) => void hooks.push(hook) };
}

function edit(expectedRevision: string, by: SourceWriteOptions['by'], extra: Partial<SourceWriteOptions> = {}): SourceWriteOptions {
  return { expectedRevision, by, message: `${by} edits`, ...extra };
}

async function countRows(client: SqlClient, table: string): Promise<number> {
  return Number((await client.query(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.n);
}

function uniqueViolation(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
}

sourceContract('db (sqlite)', async (files) => tracked(await sqliteWorkspaceSource(':memory:', { files })));

sourceContract('db (postgres client over a fake pool)', async (files) => tracked(await postgresWorkspaceSource(fakePool().pool, { files, ownsPool: true })));

describe('dbSource', () => {
  it('two concurrent writes with the same expectedRevision: one wins, one gets StaleRevisionError', async () => {
    const client = tracked(sqliteSqlClient(':memory:'));
    const ann = await dbSource(client, { files: CONTRACT_FILES });
    const bob = await dbSource(client);
    const base = await ann.revision();
    const results = await Promise.allSettled([ann.write({ 'a.md': 'ann' }, edit(base, 'person:ann')), bob.write({ 'a.md': 'bob' }, edit(base, 'person:bob'))]);
    const won = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    const lost = results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []));
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toBeInstanceOf(StaleRevisionError);
    expect(lost[0]).toMatchObject({ code: 'LOUSHO_WORKSPACE_STALE_REVISION', expectedRevision: base, currentRevision: won[0]?.revision });
    expect(await ann.history()).toEqual(won);
    expect(await bob.revision()).toBe(won[0]?.revision);
  });

  it('moves the head by compare-and-set inside the transaction, and rolls the whole write back when it lost', async () => {
    const client = tracked(sqliteSqlClient(':memory:'));
    const bob = await dbSource(client, { files: CONTRACT_FILES });
    const base = await bob.revision();
    let raced = false;
    const racing: SqlClient = {
      ...client,
      async transaction(work) {
        if (!raced) {
          raced = true;
          await bob.write({ 'a.md': 'bob' }, edit(base, 'person:bob'));
        }
        return client.transaction(work);
      },
    };
    const ann = await dbSource(racing);
    await expect(ann.write({ 'b.md': 'ann' }, edit(base, 'person:ann'))).rejects.toBeInstanceOf(StaleRevisionError);
    const history = await bob.history();
    expect(history.map((meta) => meta.by)).toEqual(['person:bob']);
    expect(await ann.revision()).toBe(history[0]?.revision);
    expect(await client.query("SELECT hash FROM file_blobs WHERE content = 'ann'")).toEqual([]);
    expect(await client.query("SELECT path FROM workspace_files WHERE path = 'b.md'")).toEqual([]);
  });

  it('a one-file edit inserts one blob', async () => {
    const client = tracked(sqliteSqlClient(':memory:'));
    const source = await dbSource(client, { files: CONTRACT_FILES });
    expect(await countRows(client, 'file_blobs')).toBe(Object.keys(CONTRACT_FILES).length);
    const one = await source.write({ 'shared/instructions/voice.md': 'Be very brief.\n' }, edit(await source.revision(), 'person:ann'));
    expect(await countRows(client, 'file_blobs')).toBe(Object.keys(CONTRACT_FILES).length + 1);
    await source.write({ 'shared/instructions/copy.md': 'Be very brief.\n' }, edit(one.revision, 'person:ann'));
    expect(await countRows(client, 'file_blobs')).toBe(Object.keys(CONTRACT_FILES).length + 1);
  });

  it('history lists revisions newest first with their kind', async () => {
    const source = tracked(await sqliteWorkspaceSource(':memory:', { files: CONTRACT_FILES }));
    let expectedRevision = await source.revision();
    for (const kind of ['import', 'authoring', 'improvement', 'rollback'] as const) {
      expectedRevision = (await source.write({ 'a.md': kind }, edit(expectedRevision, 'person:ann', { kind }))).revision;
    }
    const history = await source.history();
    expect(history.map((meta) => [meta.seq, meta.kind])).toEqual([
      [4, 'rollback'],
      [3, 'improvement'],
      [2, 'authoring'],
      [1, 'import'],
    ]);
    expect(history[1]?.parent).toBe(history[2]?.revision);
  });

  it('stores the exact serialized audit line with the revision', async () => {
    const client = tracked(sqliteSqlClient(':memory:'));
    const source = await dbSource(client, { files: CONTRACT_FILES });
    const audit = { actor: 'person:ann' as const, action: 'apply' as const, reason: 'tighten the voice' };
    await source.write({ 'a.md': '1' }, edit(await source.revision(), 'person:ann', { audit }));
    await source.write({ 'a.md': '2' }, edit(await source.revision(), 'person:ann'));
    const rows = await client.query('SELECT seq, audit FROM workspace_revisions ORDER BY seq');
    expect(rows.map((row) => [Number(row.seq), row.audit])).toEqual([
      [1, JSON.stringify(audit)],
      [2, null],
    ]);
  });

  it('keeps a workspace across a reopen, and ignores the seed files then', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-db-source-'));
    try {
      const first = await sqliteWorkspaceSource(join(dir, 'ws.db'), { files: CONTRACT_FILES });
      const meta = await first.write({ 'a.md': '1' }, edit(await first.revision(), 'person:ann'));
      await first.close();
      const again = await sqliteWorkspaceSource(join(dir, 'ws.db'), { files: { 'other.md': 'x' } });
      expect(await again.revision()).toBe(meta.revision);
      expect(await again.history()).toEqual([meta]);
      expect(await again.read('other.md')).toBeUndefined();
      await again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps workspaces apart by project and workspace id', async () => {
    const client = tracked(sqliteSqlClient(':memory:'));
    const marketing = await dbSource(client, { ref: { projectId: 'acme', workspaceId: 'marketing' }, files: CONTRACT_FILES });
    const sales = await dbSource(client, { ref: { projectId: 'acme', workspaceId: 'sales' }, files: CONTRACT_FILES });
    expect(sales.ref).toEqual({ projectId: 'acme', workspaceId: 'sales' });
    await marketing.write({ 'a.md': '1' }, edit(await marketing.revision(), 'person:ann'));
    expect(await sales.revision()).toBe(revisionId(new Map(Object.entries(CONTRACT_FILES))));
    expect(await sales.read('a.md')).toBeUndefined();
    expect(await sales.history()).toEqual([]);
  });

  it('refuses seed files outside the workspace, or that clash', async () => {
    const client = tracked(sqliteSqlClient(':memory:'));
    await expect(dbSource(client, { files: { '../x': 'y' } })).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_PATH_INVALID' });
    await expect(dbSource(client, { files: { 'A.md': '1', 'a.md': '2' } })).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_PATH_INVALID' });
    await expect(sqliteWorkspaceSource(':memory:', { files: { '.Git/config': 'x' } })).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_PATH_INVALID' });
  });

  it('retries a write that lost the seq to a concurrent writer, and refuses it once the head moved', async () => {
    const client = tracked(sqliteSqlClient(':memory:'));
    const bob = await dbSource(client, { files: CONTRACT_FILES });
    const base = await bob.revision();
    const failures: Array<() => Promise<void>> = [async () => undefined, async () => void (await bob.write({ 'a.md': 'bob' }, edit(base, 'person:bob')))];
    const flaky: SqlClient = {
      ...client,
      async transaction(work) {
        const before = failures.shift();
        if (!before) return client.transaction(work);
        await before();
        throw uniqueViolation();
      },
    };
    const ann = await dbSource(flaky);
    await expect(ann.write({ 'b.md': 'ann' }, edit(base, 'person:ann'))).rejects.toBeInstanceOf(StaleRevisionError);
    expect((await bob.history()).map((meta) => meta.by)).toEqual(['person:bob']);
    failures.push(async () => undefined);
    const meta = await ann.write({ 'b.md': 'ann' }, edit(await ann.revision(), 'person:ann'));
    expect(meta.seq).toBe(2);
  });
});

describe('the Postgres adapter', () => {
  it('runs a write in one transaction on one pooled connection, with numbered placeholders', async () => {
    const { pool, calls, released } = fakePool();
    const source = tracked(await postgresWorkspaceSource(pool, { files: CONTRACT_FILES, ownsPool: true }));
    calls.splice(0);
    await source.write({ 'a.md': '1' }, edit(await source.revision(), 'person:ann'));
    const inTransaction = calls.filter((call) => call.on === 'connection').map((call) => call.text);
    expect(inTransaction[0]).toBe('BEGIN');
    expect(inTransaction.at(-1)).toBe('COMMIT');
    expect(inTransaction.some((text) => text.startsWith('UPDATE workspace_heads SET revision = $1'))).toBe(true);
    expect(calls.every((call) => !call.text.includes('?'))).toBe(true);
    expect(released()).toBe(2);
  });

  it('rolls back and releases the connection when the head moved', async () => {
    const { pool, calls, released, onConnect } = fakePool();
    const bob = tracked(await postgresWorkspaceSource(pool, { files: CONTRACT_FILES, ownsPool: true }));
    const ann = await postgresWorkspaceSource(pool);
    const base = await bob.revision();
    onConnect(async () => void (await bob.write({ 'a.md': 'bob' }, edit(base, 'person:bob'))));
    await expect(ann.write({ 'b.md': 'ann' }, edit(base, 'person:ann'))).rejects.toBeInstanceOf(StaleRevisionError);
    expect(calls.at(-1)).toMatchObject({ on: 'connection', text: 'ROLLBACK' });
    expect(released()).toBe(3);
    await ann.close();
  });

  it('refuses a transaction without a pool to check a connection out of', async () => {
    const client = postgresSqlClient({ query: async () => ({ rows: [], rowCount: 0 }) });
    await expect(client.transaction(async () => 1)).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
  });
});

const PG_URL = process.env.LOUSHO_TEST_PG_URL;
const PG_MODULE = 'pg';

describe.skipIf(PG_URL === undefined)('db (postgres at LOUSHO_TEST_PG_URL)', () => {
  async function newPool(): Promise<PgPool> {
    const pg = (await import(PG_MODULE)) as { default: { Pool: new (config: { connectionString?: string }) => PgPool } };
    return new pg.default.Pool({ connectionString: PG_URL });
  }

  async function make(files: Record<string, string>) {
    return tracked(await postgresWorkspaceSource(await newPool(), { files, ref: { projectId: 'lousho-test', workspaceId: randomUUID() }, ownsPool: true }));
  }

  sourceContract('db (postgres)', make);

  it('two writers on separate pools with the same expectedRevision: one wins, one gets StaleRevisionError', async () => {
    const ann = await make(CONTRACT_FILES);
    const bob = tracked(await postgresWorkspaceSource(await newPool(), { ref: ann.ref, ownsPool: true }));
    const base = await ann.revision();
    const results = await Promise.allSettled([ann.write({ 'a.md': 'ann' }, edit(base, 'person:ann')), bob.write({ 'a.md': 'bob' }, edit(base, 'person:bob'))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')?.reason).toBeInstanceOf(StaleRevisionError);
    expect(await ann.history()).toHaveLength(1);
  });
});
