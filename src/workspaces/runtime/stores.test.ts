import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Checkpoint } from '../../execution/checkpoint';
import type { PageRunEvent } from '../contracts/execution';
import { appendFileSync, writeFileSync } from 'node:fs';
import { pglitePool } from '../__fixtures__/pglitePool';
import { fileHostBackend, postgresHostBackend, sqliteHostBackend } from './backends';
import { postgresSqlClient, sqliteSqlClient, type PgQueryable } from './sql';
import { sqliteWorkspaceSource } from '../source/dbSource';
import { createWorkspaceStores, type HostBackend, type WorkspaceScope } from './stores';

const dirs: string[] = [];
const open: HostBackend[] = [];

afterEach(async () => {
  for (const backend of open.splice(0)) await backend.close();
  await dropLiveSchemas();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-host-stores-'));
  dirs.push(dir);
  return dir;
}

const PG_URL = process.env.LOUSHO_TEST_PG_URL;

const sharedSchemas = new Map<string, string>();

async function dropLiveSchemas(): Promise<void> {
  const schemas = [...sharedSchemas.values()];
  sharedSchemas.clear();
  if (schemas.length === 0) return;
  const cleanup = new pg.Pool({ connectionString: PG_URL });
  for (const schema of schemas) await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await cleanup.end();
}

async function liveBackend(dir: string): Promise<HostBackend> {
  let schema = sharedSchemas.get(dir);
  if (schema === undefined) {
    schema = `lousho_${randomUUID().replaceAll('-', '')}`;
    sharedSchemas.set(dir, schema);
    const setup = new pg.Pool({ connectionString: PG_URL });
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.end();
  }
  return postgresHostBackend(new pg.Pool({ connectionString: PG_URL, options: `-c search_path=${schema}` }), { ownsPool: true });
}

const BACKENDS: Array<[string, (dir: string) => Promise<HostBackend>]> = [
  ['file', async (dir) => fileHostBackend(join(dir, 'files'))],
  ['sqlite', (dir) => sqliteHostBackend(join(dir, 'host.db'))],
  ['sql tables on a shared sqlite connection', (dir) => sqliteHostBackend(sqliteSqlClient(join(dir, 'sql.db')))],
  ['postgres over pglite', (dir) => postgresHostBackend(pglitePool(join(dir, 'pg')), { ownsPool: true })],
  ...(PG_URL === undefined ? [] : [['postgres at LOUSHO_TEST_PG_URL', liveBackend] as [string, (dir: string) => Promise<HostBackend>]]),
];

const A: WorkspaceScope = { projectId: 'proj-1', workspaceId: 'marketing' };
const B: WorkspaceScope = { projectId: 'proj-1', workspaceId: 'coding' };
const progress = (message: string): PageRunEvent => ({ type: 'progress', message });
const checkpoint = (status?: Checkpoint['status']): Checkpoint =>
  ({ agentId: 'a', sessionId: 's', stepIndex: 1, messages: [{ role: 'user', content: 'hi' }], toolCalls: [], usage: {}, status }) as unknown as Checkpoint;

describe.each(BACKENDS)('the store contract on %s', (_name, make) => {
  async function backend(dir = scratch()): Promise<HostBackend> {
    const made = await make(dir);
    open.push(made);
    return made;
  }

  it('threads are isolated by workspace id', async () => {
    const host = await backend();
    const marketing = createWorkspaceStores(host, A);
    const coding = createWorkspaceStores(host, B);
    await marketing.threads.save('t1', [{ role: 'user', content: 'plan the launch' }]);
    expect(await coding.threads.load('t1')).toBeUndefined();
    expect(await marketing.threads.load('t1')).toEqual([{ role: 'user', content: 'plan the launch' }]);
    await marketing.checkpoints.save('run-1', checkpoint('awaiting-approval'));
    expect(await coding.checkpoints.load('run-1')).toBeNull();
    expect((await marketing.checkpoints.list({ status: 'awaiting-approval' })).map((entry) => entry.sessionId)).toEqual(['run-1']);
    expect(await coding.checkpoints.list()).toEqual([]);
    await marketing.threads.delete('t1');
    expect(await marketing.threads.load('t1')).toBeUndefined();
  });

  it('keeps runs of one workspace out of another', async () => {
    const host = await backend();
    const marketing = createWorkspaceStores(host, A);
    const coding = createWorkspaceStores(host, B);
    await marketing.runs.start({ runId: 'run-1', pageId: 'post', revision: 'r1' });
    expect(await coding.runs.get('run-1')).toBeUndefined();
    expect(await coding.runs.list()).toEqual([]);
    await expect(coding.events.append('run-1', progress('x'))).rejects.toThrow();
    await expect(marketing.runs.start({ runId: 'run-1', pageId: 'post', revision: 'r1' })).rejects.toThrow();
  });

  it('records a run through its lifecycle', async () => {
    const stores = createWorkspaceStores(await backend(), A);
    const started = await stores.runs.start({ runId: 'run-1', pageId: 'post', revision: 'r7' });
    expect(started).toMatchObject({ ...A, runId: 'run-1', pageId: 'post', revision: 'r7', status: 'running' });
    expect((await stores.runs.finish('run-1', 'needs-approval')).endedAt).toBeUndefined();
    const done = await stores.runs.finish('run-1', 'ok');
    expect(done.status).toBe('ok');
    expect(typeof done.endedAt).toBe('number');
    expect(await stores.runs.get('run-1')).toEqual(done);
    expect(await stores.runs.list(['running'])).toEqual([]);
    expect(await stores.runs.list(['ok'])).toEqual([done]);
  });

  it('keeps the thread and the parent run of a run row', async () => {
    const stores = createWorkspaceStores(await backend(), A);
    await stores.runs.start({ runId: 'ws-1', pageId: '', revision: 'r1', threadId: 'thread-1' });
    await stores.runs.start({ runId: 'page-1', pageId: 'post', revision: 'r1', threadId: 'thread-1', parentRunId: 'ws-1' });
    await stores.runs.finish('page-1', 'ok');
    expect(await stores.runs.get('ws-1')).toMatchObject({ threadId: 'thread-1' });
    expect((await stores.runs.get('ws-1'))?.parentRunId).toBeUndefined();
    expect(await stores.runs.get('page-1')).toMatchObject({ threadId: 'thread-1', parentRunId: 'ws-1', status: 'ok' });
  });

  it('a run row survives a restart and is marked interrupted', async () => {
    const dir = scratch();
    const first = await make(dir);
    const before = createWorkspaceStores(first, A);
    await before.runs.start({ runId: 'run-1', pageId: 'post', revision: 'r1' });
    await before.runs.start({ runId: 'run-2', pageId: 'post', revision: 'r1' });
    await before.runs.finish('run-2', 'ok');
    await first.close();

    const second = await make(dir);
    open.push(second);
    const after = createWorkspaceStores(second, A);
    expect(await after.runs.get('run-1')).toMatchObject({ status: 'running', revision: 'r1' });
    const interrupted = await after.runs.markInterrupted();
    expect(interrupted.map((run) => run.runId)).toEqual(['run-1']);
    expect(await after.runs.get('run-1')).toMatchObject({ status: 'interrupted' });
    expect(await after.runs.get('run-2')).toMatchObject({ status: 'ok' });
  });

  it('continues the per-run event sequence after a restart and reads from Last-Event-ID', async () => {
    const dir = scratch();
    const first = await make(dir);
    const before = createWorkspaceStores(first, A);
    await before.runs.start({ runId: 'run-1', pageId: 'post', revision: 'r1' });
    await before.runs.start({ runId: 'run-2', pageId: 'post', revision: 'r1' });
    const ids = [
      (await before.events.append('run-1', progress('a'))).id,
      (await before.events.append('run-1', progress('b'))).id,
      (await before.events.append('run-2', progress('other'))).id,
    ];
    expect(ids).toEqual([0, 1, 0]);
    await first.close();

    const second = await make(dir);
    open.push(second);
    const after = createWorkspaceStores(second, A);
    expect((await after.events.append('run-1', progress('c'))).id).toBe(2);
    const all = await after.events.read('run-1');
    expect(all.map((event) => event.id)).toEqual([0, 1, 2]);
    expect(all.every((event) => event.runId === 'run-1')).toBe(true);
    expect((await after.events.read('run-1', 1)).map((event) => event.event)).toEqual([progress('c')]);
    expect(await after.events.read('run-1', 2)).toEqual([]);
  });

  it('numbers concurrent appends without gaps or repeats', async () => {
    const stores = createWorkspaceStores(await backend(), A);
    await stores.runs.start({ runId: 'run-1', pageId: 'post', revision: 'r1' });
    const written = await Promise.all(Array.from({ length: 8 }, (_, i) => stores.events.append('run-1', progress(String(i)))));
    expect(written.map((event) => event.id).sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('refuses ids that could escape their key', async () => {
    const stores = createWorkspaceStores(await backend(), A);
    await expect(stores.threads.load('a_b')).rejects.toThrow();
    await expect(stores.runs.start({ runId: '../x', pageId: 'p', revision: 'r' })).rejects.toThrow();
    const host = await backend();
    expect(() => createWorkspaceStores(host, { projectId: 'a_b', workspaceId: 'w' })).toThrow();
  });

  it('lets two workspaces use the same run id without collision or leak', async () => {
    const host = await backend();
    const marketing = createWorkspaceStores(host, A);
    const coding = createWorkspaceStores(host, B);
    await marketing.runs.start({ runId: 'run-1', pageId: 'post', revision: 'r1' });
    await coding.runs.start({ runId: 'run-1', pageId: 'fix', revision: 'r9' });
    await marketing.events.append('run-1', progress('m'));
    await coding.events.append('run-1', progress('c1'));
    await coding.events.append('run-1', progress('c2'));
    await coding.runs.finish('run-1', 'ok');
    expect(await marketing.runs.get('run-1')).toMatchObject({ pageId: 'post', status: 'running' });
    expect(await coding.runs.get('run-1')).toMatchObject({ pageId: 'fix', status: 'ok' });
    expect((await marketing.events.read('run-1')).map((e) => e.event)).toEqual([progress('m')]);
    expect((await coding.events.read('run-1')).map((e) => e.id)).toEqual([0, 1]);
    const other = createWorkspaceStores(host, { projectId: 'proj-2', workspaceId: 'marketing' });
    expect(await other.runs.get('run-1')).toBeUndefined();
    await expect(other.runs.finish('run-1', 'ok')).rejects.toThrow();
  });

  it('lists checkpoints of one workspace only, even when ids look alike', async () => {
    const host = await backend();
    const near = createWorkspaceStores(host, { projectId: 'proj-1', workspaceId: 'marketing2' });
    const marketing = createWorkspaceStores(host, A);
    await near.checkpoints.save('run-1', checkpoint());
    await marketing.checkpoints.save('run-2', checkpoint());
    expect((await marketing.checkpoints.list()).map((entry) => entry.sessionId)).toEqual(['run-2']);
  });
});

describe('the file ledger after a torn write', () => {
  it('drops a torn last event line before appending and skips unreadable lines', async () => {
    const dir = scratch();
    const host = fileHostBackend(dir);
    const stores = createWorkspaceStores(host, A);
    await stores.runs.start({ runId: 'run-1', pageId: 'post', revision: 'r1' });
    await stores.events.append('run-1', progress('a'));
    const file = join(dir, 'workspaces', 'events', A.projectId, A.workspaceId, 'run-1.ndjson');
    appendFileSync(file, '{"type":"progress","mess');
    expect((await stores.events.read('run-1')).map((e) => e.id)).toEqual([0]);
    expect((await stores.events.append('run-1', progress('b'))).id).toBe(1);
    expect((await stores.events.read('run-1')).map((e) => e.event)).toEqual([progress('a'), progress('b')]);
    writeFileSync(file, `${JSON.stringify(progress('a'))}\nnot json\n${JSON.stringify(progress('c'))}\n`);
    expect((await stores.events.read('run-1')).map((e) => e.id)).toEqual([0, 2]);
  });
});

describe('the Postgres backend', () => {
  it('leaves a host-owned pool open unless it owns the pool', async () => {
    let ended = 0;
    const pool: PgQueryable = { query: async () => ({ rows: [], rowCount: 0 }), end: async () => void ended++ };
    await (await postgresHostBackend(pool)).close();
    expect(ended).toBe(0);
    await (await postgresHostBackend(pool, { ownsPool: true })).close();
    expect(ended).toBe(1);
  });
});

describe('the Postgres client', () => {
  it('numbers placeholders and binds every value instead of building SQL', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const pool: PgQueryable = {
      async query(text, values) {
        calls.push({ text, values });
        return { rows: [{ seq: 4 }], rowCount: 1 };
      },
    };
    const client = postgresSqlClient(pool);
    expect(await client.query('SELECT * FROM ws_runs WHERE run_id = ? AND status = ?', ["x' OR 1=1 --", 'ok'])).toEqual([{ seq: 4 }]);
    expect(await client.execute('DELETE FROM ws_threads WHERE key = ?', ['k'])).toBe(1);
    expect(calls[0]).toEqual({ text: 'SELECT * FROM ws_runs WHERE run_id = $1 AND status = $2', values: ["x' OR 1=1 --", 'ok'] });
    expect(calls[1]?.text).toBe('DELETE FROM ws_threads WHERE key = $1');
  });
});

describe('host backends and shared connections', () => {
  it('a hand-built backend fails createWorkspaceStores with a config error', () => {
    const fake: HostBackend = { close: async () => undefined };
    expect(() => createWorkspaceStores(fake, A)).toThrow(expect.objectContaining({ code: 'LOUSHO_CONFIG_INVALID' }));
  });

  it('sqliteHostBackend and sqliteWorkspaceSource share one connection, and the backend leaves it open', async () => {
    const client = sqliteSqlClient(join(scratch(), 'one.db'));
    const backend = await sqliteHostBackend(client);
    const source = await sqliteWorkspaceSource(client, { ref: { projectId: 'proj-1', workspaceId: 'marketing' } });
    const stores = createWorkspaceStores(backend, A);
    await stores.runs.start({ runId: 'run-1', pageId: 'p', revision: await source.revision() });
    await backend.close();
    expect((await client.query('SELECT run_id FROM ws_runs')).map((row) => row.run_id)).toEqual(['run-1']);
    await client.close();
  });

  it('refuses a SQL client that is not a sqliteSqlClient', async () => {
    const pgClient = postgresSqlClient({ query: async () => ({ rows: [], rowCount: 0 }) });
    await expect(sqliteHostBackend(pgClient)).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
    await expect(sqliteWorkspaceSource(pgClient)).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
  });
});
