import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pglitePool } from '../__fixtures__/pglitePool';
import { loadDatabaseSync, type SqlValue } from '../../storage/sqlite/driver';
import { postgresSqlClient, sqliteSqlClient, type PgPool, type PgQueryable, type SqlClient } from '../runtime/sql';
import { postgresWorkspaceSource, sqliteWorkspaceSource } from './dbSource';
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

interface FakePool {
  pool: PgPool;
  calls: PgCall[];
  releases: unknown[];
  onConnect: (hook: () => Promise<void>) => void;
  failRollback: () => void;
}

function fakePool(): FakePool {
  const db = new (loadDatabaseSync())(':memory:');
  const calls: PgCall[] = [];
  const hooks: Array<() => Promise<void>> = [];
  const releases: unknown[] = [];
  let rollbackFails = false;
  const run =
    (on: PgCall['on']): PgQuery =>
    async (text, values = []) => {
      calls.push({ on, text, values });
      if (text === 'ROLLBACK' && rollbackFails) throw new TypeError('connection terminated');
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) {
        db.exec(text);
        return { rows: [], rowCount: null };
      }
      if (text.includes('pg_advisory_xact_lock')) return { rows: [{ pg_advisory_xact_lock: '' }], rowCount: 1 };
      const statement = db.prepare(text.replace(/\$\d+/g, '?'));
      const bound = [...text.matchAll(/\$(\d+)/g)].map((match) => values[Number(match[1]) - 1]) as SqlValue[];
      if (/^\s*SELECT/i.test(text)) return { rows: statement.all(...bound), rowCount: null };
      return { rows: [], rowCount: Number(statement.run(...bound).changes) };
    };
  const pool: PgPool = {
    query: run('pool'),
    async connect() {
      for (const hook of hooks.splice(0)) await hook();
      return { query: run('connection'), release: (error) => void releases.push(error) };
    },
    end: async () => db.close(),
  };
  return { pool, calls, releases, onConnect: (hook) => void hooks.push(hook), failRollback: () => void (rollbackFails = true) };
}

function transactions(calls: PgCall[]): string[][] {
  const groups: string[][] = [];
  for (const call of calls.filter((each) => each.on === 'connection')) {
    if (call.text === 'BEGIN') groups.push([]);
    groups.at(-1)?.push(call.text);
  }
  return groups;
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

sourceContract('db (postgres over pglite)', async (files) => tracked(await postgresWorkspaceSource(pglitePool(), { files, ownsPool: true })));

sourceContract('db (postgres client over a fake pool)', async (files) => tracked(await postgresWorkspaceSource(fakePool().pool, { files, ownsPool: true })));

describe('dbSource', () => {
  it('two concurrent writes with the same expectedRevision: one wins, one gets StaleRevisionError', async () => {
    const client = tracked(sqliteSqlClient(':memory:'));
    const ann = await sqliteWorkspaceSource(client, { files: CONTRACT_FILES });
    const bob = await sqliteWorkspaceSource(client);
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
    const bob = await sqliteWorkspaceSource(client, { files: CONTRACT_FILES });
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
    const ann = await sqliteWorkspaceSource(racing);
    await expect(ann.write({ 'b.md': 'ann' }, edit(base, 'person:ann'))).rejects.toBeInstanceOf(StaleRevisionError);
    const history = await bob.history();
    expect(history.map((meta) => meta.by)).toEqual(['person:bob']);
    expect(await ann.revision()).toBe(history[0]?.revision);
    expect(await client.query("SELECT hash FROM file_blobs WHERE content = 'ann'")).toEqual([]);
    expect(await client.query("SELECT path FROM workspace_files WHERE path = 'b.md'")).toEqual([]);
  });

  it('a one-file edit inserts one blob', async () => {
    const client = tracked(sqliteSqlClient(':memory:'));
    const source = await sqliteWorkspaceSource(client, { files: CONTRACT_FILES });
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
    const source = await sqliteWorkspaceSource(client, { files: CONTRACT_FILES });
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
    const marketing = await sqliteWorkspaceSource(client, { ref: { projectId: 'acme', workspaceId: 'marketing' }, files: CONTRACT_FILES });
    const sales = await sqliteWorkspaceSource(client, { ref: { projectId: 'acme', workspaceId: 'sales' }, files: CONTRACT_FILES });
    expect(sales.ref).toEqual({ projectId: 'acme', workspaceId: 'sales' });
    await marketing.write({ 'a.md': '1' }, edit(await marketing.revision(), 'person:ann'));
    expect(await sales.revision()).toBe(revisionId(new Map(Object.entries(CONTRACT_FILES))));
    expect(await sales.read('a.md')).toBeUndefined();
    expect(await sales.history()).toEqual([]);
  });

  it('refuses NUL content, which SQLite would cut short and Postgres rejects, and records nothing', async () => {
    const client = tracked(sqliteSqlClient(':memory:'));
    const source = await sqliteWorkspaceSource(client, { files: CONTRACT_FILES });
    const base = await source.revision();
    await expect(source.write({ 'n.md': 'a\u0000b' }, edit(base, 'person:ann'))).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_CONTENT_UNSUPPORTED' });
    expect(await source.revision()).toBe(base);
    expect(await source.history()).toEqual([]);
    expect(await countRows(client, 'file_blobs')).toBe(Object.keys(CONTRACT_FILES).length);
    await expect(sqliteWorkspaceSource(':memory:', { files: { 'n.md': '\u0000' } })).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_CONTENT_UNSUPPORTED' });
  });

  it('shares one connection between workspaces on one file, and leaves a shared connection open on close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-db-source-'));
    try {
      const client = sqliteSqlClient(join(dir, 'ws.db'));
      const ann = await sqliteWorkspaceSource(client, { files: CONTRACT_FILES });
      const bob = await sqliteWorkspaceSource(client);
      const base = await ann.revision();
      const results = await Promise.allSettled([ann.write({ 'a.md': 'ann' }, edit(base, 'person:ann')), bob.write({ 'a.md': 'bob' }, edit(base, 'person:bob'))]);
      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      await ann.close();
      expect(await bob.history()).toHaveLength(1);
      await client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses seed files outside the workspace, or that clash', async () => {
    const client = tracked(sqliteSqlClient(':memory:'));
    await expect(sqliteWorkspaceSource(client, { files: { '../x': 'y' } })).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_PATH_INVALID' });
    await expect(sqliteWorkspaceSource(client, { files: { 'A.md': '1', 'a.md': '2' } })).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_PATH_INVALID' });
    await expect(sqliteWorkspaceSource(':memory:', { files: { '.Git/config': 'x' } })).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_PATH_INVALID' });
  });

  it('retries a write that lost the seq to a concurrent writer, and refuses it once the head moved', async () => {
    const client = tracked(sqliteSqlClient(':memory:'));
    const bob = await sqliteWorkspaceSource(client, { files: CONTRACT_FILES });
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
    const ann = await sqliteWorkspaceSource(flaky);
    await expect(ann.write({ 'b.md': 'ann' }, edit(base, 'person:ann'))).rejects.toBeInstanceOf(StaleRevisionError);
    expect((await bob.history()).map((meta) => meta.by)).toEqual(['person:bob']);
    failures.push(async () => undefined);
    const meta = await ann.write({ 'b.md': 'ann' }, edit(await ann.revision(), 'person:ann'));
    expect(meta.seq).toBe(2);
  });
});

describe('the Postgres adapter on real Postgres (pglite)', () => {
  it('a sequential stale writer on one pglite connection gets StaleRevisionError (real concurrency is covered only under LOUSHO_TEST_PG_URL)', async () => {
    const pool = pglitePool();
    const ann = tracked(await postgresWorkspaceSource(pool, { files: CONTRACT_FILES }));
    const bob = await postgresWorkspaceSource(pool, { ref: ann.ref });
    const base = await ann.revision();
    const results = await Promise.allSettled([ann.write({ 'a.md': 'ann' }, edit(base, 'person:ann')), bob.write({ 'a.md': 'bob' }, edit(base, 'person:bob'))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')?.reason).toBeInstanceOf(StaleRevisionError);
    expect(await ann.history()).toHaveLength(1);
    await pool.end?.();
  });

  it('refuses NUL content, which Postgres TEXT rejects', async () => {
    const source = tracked(await postgresWorkspaceSource(pglitePool(), { files: CONTRACT_FILES, ownsPool: true }));
    await expect(source.write({ 'n.md': 'a\u0000b' }, edit(await source.revision(), 'person:ann'))).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_CONTENT_UNSUPPORTED' });
    expect(await source.history()).toHaveLength(0);
  });
});

describe('the Postgres adapter', () => {
  it('runs a write in one transaction on one pooled connection, with numbered placeholders', async () => {
    const { pool, calls, releases } = fakePool();
    const source = tracked(await postgresWorkspaceSource(pool, { files: CONTRACT_FILES, ownsPool: true }));
    calls.splice(0);
    await source.write({ 'a.md': '1' }, edit(await source.revision(), 'person:ann'));
    const [write] = transactions(calls);
    expect(write?.[0]).toBe('BEGIN');
    expect(write?.at(-1)).toBe('COMMIT');
    expect(write?.some((text) => text.startsWith('UPDATE workspace_heads SET revision = $1'))).toBe(true);
    expect(calls.every((call) => !call.text.includes('?'))).toBe(true);
    expect(releases).toEqual([undefined, undefined, undefined]);
  });

  it('creates its tables in one transaction under an advisory lock', async () => {
    const { pool, calls } = fakePool();
    tracked(await postgresWorkspaceSource(pool, { ownsPool: true }));
    const [migration] = transactions(calls);
    expect(migration?.slice(0, 2)).toEqual(['BEGIN', 'SELECT pg_advisory_xact_lock(7311701)']);
    expect(migration?.filter((text) => text.startsWith('CREATE TABLE'))).toHaveLength(4);
    expect(migration?.at(-1)).toBe('COMMIT');
  });

  it('inserts blobs sorted by hash and file rows sorted by path, so two writers lock rows in the same order', async () => {
    const { pool, calls } = fakePool();
    const source = tracked(await postgresWorkspaceSource(pool, { ownsPool: true }));
    calls.splice(0);
    await source.write({ 'z.md': 'one', 'a.md': 'two', 'm.md': 'three' }, edit(await source.revision(), 'person:ann'));
    const blobHashes = calls.filter((call) => call.text.startsWith('INSERT INTO file_blobs')).map((call) => String(call.values[0]));
    const filePaths = calls.filter((call) => call.text.startsWith('INSERT INTO workspace_files')).map((call) => String(call.values[3]));
    expect(blobHashes).toEqual([...blobHashes].sort());
    expect(blobHashes).toHaveLength(3);
    expect(filePaths).toEqual(['a.md', 'm.md', 'z.md']);
  });

  it('rolls back and releases the connection when the head moved', async () => {
    const { pool, calls, releases, onConnect } = fakePool();
    const bob = tracked(await postgresWorkspaceSource(pool, { files: CONTRACT_FILES, ownsPool: true }));
    const ann = await postgresWorkspaceSource(pool);
    const base = await bob.revision();
    const before = releases.length;
    onConnect(async () => void (await bob.write({ 'a.md': 'bob' }, edit(base, 'person:bob'))));
    await expect(ann.write({ 'b.md': 'ann' }, edit(base, 'person:ann'))).rejects.toBeInstanceOf(StaleRevisionError);
    expect(calls.at(-1)).toMatchObject({ on: 'connection', text: 'ROLLBACK' });
    expect(releases.slice(before)).toEqual([undefined, undefined]);
    await ann.close();
  });

  it('tells the pool to discard a connection whose ROLLBACK failed', async () => {
    const { pool, releases, failRollback } = fakePool();
    const client = tracked(postgresSqlClient(pool, { ownsPool: true }, () => pool.connect()));
    failRollback();
    await expect(client.transaction(async () => Promise.reject(new TypeError('boom')))).rejects.toThrow('boom');
    expect(releases.at(-1)).toBeInstanceOf(TypeError);
    expect(String(releases.at(-1))).toContain('connection terminated');
  });

  it('refuses NUL content before it reaches the database', async () => {
    const { pool, calls } = fakePool();
    const source = tracked(await postgresWorkspaceSource(pool, { files: CONTRACT_FILES, ownsPool: true }));
    calls.splice(0);
    await expect(source.write({ 'n.md': 'a\u0000b' }, edit(await source.revision(), 'person:ann'))).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_CONTENT_UNSUPPORTED' });
    expect(calls.filter((call) => call.text.startsWith('INSERT'))).toEqual([]);
  });

  it('refuses a transaction without a pool to check a connection out of', async () => {
    const client = postgresSqlClient({ query: async () => ({ rows: [], rowCount: 0 }) });
    await expect(client.transaction(async () => 1)).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
  });
});

const PG_URL = process.env.LOUSHO_TEST_PG_URL;

describe.skipIf(PG_URL === undefined)('db (postgres at LOUSHO_TEST_PG_URL)', () => {
  async function newPool(schema: string): Promise<PgPool> {
    return new pg.Pool({ connectionString: PG_URL, options: `-c search_path=${schema}` });
  }

  async function newSchema(): Promise<string> {
    const schema = `lousho_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: PG_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    tracked({
      async close() {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      },
    });
    return schema;
  }

  async function make(files: Record<string, string>) {
    const schema = await newSchema();
    return tracked(await postgresWorkspaceSource(await newPool(schema), { files, ref: { projectId: 'lousho-test', workspaceId: randomUUID() }, ownsPool: true }));
  }

  sourceContract('db (postgres)', make);

  it('two writers on separate pools with the same expectedRevision: one wins, one gets StaleRevisionError', async () => {
    const ann = await make(CONTRACT_FILES);
    const bob = tracked(await postgresWorkspaceSource(await newPool(await newSchema()), { ref: ann.ref, ownsPool: true }));
    const base = await ann.revision();
    const results = await Promise.allSettled([ann.write({ 'a.md': 'ann' }, edit(base, 'person:ann')), bob.write({ 'a.md': 'bob' }, edit(base, 'person:bob'))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')?.reason).toBeInstanceOf(StaleRevisionError);
    expect(await ann.history()).toHaveLength(1);
  });
});
