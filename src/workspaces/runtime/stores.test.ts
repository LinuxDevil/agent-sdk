import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Checkpoint } from '../../execution/checkpoint';
import type { PageRunEvent } from '../contracts/execution';
import { fileHostBackend, sqlHostBackend, sqliteHostBackend, type ClosableHostBackend } from './backends';
import { postgresSqlClient, sqliteSqlClient, type PgQueryable } from './sql';
import { createWorkspaceStores, type WorkspaceScope } from './stores';

const dirs: string[] = [];
const open: ClosableHostBackend[] = [];

afterEach(async () => {
  for (const backend of open.splice(0)) await backend.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-host-stores-'));
  dirs.push(dir);
  return dir;
}

const BACKENDS: Array<[string, (dir: string) => Promise<ClosableHostBackend>]> = [
  ['file', async (dir) => fileHostBackend(join(dir, 'files'))],
  ['sqlite', (dir) => sqliteHostBackend(join(dir, 'host.db'))],
  ['sql tables on sqlite', (dir) => sqlHostBackend(sqliteSqlClient(join(dir, 'sql.db')))],
];

const A: WorkspaceScope = { projectId: 'proj-1', workspaceId: 'marketing' };
const B: WorkspaceScope = { projectId: 'proj-1', workspaceId: 'coding' };
const progress = (message: string): PageRunEvent => ({ type: 'progress', message });
const checkpoint = (status?: Checkpoint['status']): Checkpoint =>
  ({ agentId: 'a', sessionId: 's', stepIndex: 1, messages: [{ role: 'user', content: 'hi' }], toolCalls: [], usage: {}, status }) as unknown as Checkpoint;

describe.each(BACKENDS)('the store contract on %s', (_name, make) => {
  async function backend(dir = scratch()): Promise<ClosableHostBackend> {
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
    expect(() => createWorkspaceStores({ agent: {}, ledger: {} as never }, { projectId: 'a_b', workspaceId: 'w' })).toThrow();
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
