/**
 * Eve DUR-F4: the LOUSHO_SESSION_BUSY base check was a load, compare, save. Two writers that cannot share the
 * in-process queue (two store objects over the same data: two processes or replicas) whose turns finished at the
 * same moment both passed the check and both committed, so one turn was silently lost while both callers got 'ok'.
 * A session now commits through the store's `saveIf` compare-and-swap when the store has one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { FileSessionStore, transcriptRevision, type SessionStore } from './sessionStore';
import { SqliteStore } from '../storage/sqlite';

const dirs: string[] = [];
const closers: (() => void)[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-saveif-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Two agents ("replicas") over two store objects of the same data, whose model calls answer at the same instant. */
async function raceTwoReplicas(make: () => SessionStore): Promise<{ results: PromiseSettledResult<unknown>[]; users: unknown[] }> {
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  const model = () =>
    mockModel(
      [
        async (request) => {
          await gate;
          return `ack ${String(request.messages.at(-1)?.content)}`;
        },
      ],
      { onExhausted: 'repeat-last' }
    );
  const replicaA = createAgent({ provider: model(), store: { sessions: make() } });
  const replicaB = createAgent({ provider: model(), store: { sessions: make() } });
  const pending = Promise.allSettled([replicaA.session({ id: 'chat' }).send('from replica A'), replicaB.session({ id: 'chat' }).send('from replica B')]);
  setTimeout(release, 20);
  const results = await pending;
  const stored = (await make().load('chat')) ?? [];
  return { results, users: stored.filter((m) => m.role === 'user').map((m) => m.content) };
}

describe('session commit is a compare-and-swap (Eve DUR-F4)', () => {
  const cases: [string, () => () => SessionStore][] = [
    [
      'FileSessionStore x2',
      () => {
        const dir = tempDir();
        return () => new FileSessionStore(dir);
      },
    ],
    [
      'SqliteStore x2',
      () => {
        const path = join(tempDir(), 'agent.db');
        return () => {
          const store = new SqliteStore(path);
          closers.push(() => store.close());
          return store.sessions;
        };
      },
    ],
  ];

  it.each(cases)('%s: one turn commits, the other fails with LOUSHO_SESSION_BUSY, none is lost', async (_name, setup) => {
    const { results, users } = await raceTwoReplicas(setup());
    const ok = results.filter((r) => r.status === 'fulfilled');
    const busy = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(busy).toHaveLength(1);
    expect((busy[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'LOUSHO_SESSION_BUSY' });
    expect(users).toHaveLength(1);
  });

  it('transcriptRevision treats a missing transcript as an empty one and tells transcripts apart', () => {
    expect(transcriptRevision(undefined)).toBe(transcriptRevision([]));
    expect(transcriptRevision([{ role: 'user', content: 'a' }])).not.toBe(transcriptRevision([{ role: 'user', content: 'b' }]));
  });
});

describe('FileSessionStore.saveIf lock', () => {
  it('takes over a stale lock file left by a crashed writer', async () => {
    const dir = tempDir();
    const store = new FileSessionStore(dir, { staleLockMs: 50 });
    await store.save('a', [{ role: 'user', content: 'hi' }]);
    const { writeFileSync, utimesSync } = await import('node:fs');
    const lock = join(dir, 'a.json.lock');
    writeFileSync(lock, 'crashed');
    const old = new Date(Date.now() - 10_000);
    utimesSync(lock, old, old);
    expect(await store.saveIf('a', transcriptRevision([{ role: 'user', content: 'hi' }]), [])).toBe(true);
    expect(await store.load('a')).toEqual([]);
  });
});
