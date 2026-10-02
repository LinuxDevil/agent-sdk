/**
 * N3a: `session.history()` / `session.fork()` against every shipped
 * `AgentStore` (in memory, `fileStore()`, `SqliteStore`, `KVStore`). A fork
 * uses only `SessionStore.load` / `save` and `CheckpointStore.load`, so every
 * store must pass the same contract.
 */
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { memoryStore, type AgentStore } from '../storage/agentStore';
import { fileStore } from '../storage/fileStore';
import { SqliteStore } from '../storage/sqlite';
import { KVStore } from '../deploy/kvStore';
import { makeCheckpoint } from '../storage/sqlite/__fixtures__/storeContracts';
import { mockModel, type MockTurn } from '../testing';

// fileStore() writes real files; slow on a loaded Windows machine.
vi.setConfig({ testTimeout: 20_000 });

const sqliteStores: SqliteStore[] = [];
afterEach(() => {
  while (sqliteStores.length) sqliteStores.pop()?.close();
});
const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const stores: Array<[string, () => Required<AgentStore>]> = [
  ['memoryStore()', () => memoryStore()],
  [
    'fileStore()',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'lousho-fork-contract-'));
      tempDirs.push(dir);
      return fileStore(dir);
    },
  ],
  [
    'SqliteStore',
    () => {
      const store = new SqliteStore(':memory:');
      sqliteStores.push(store);
      return store;
    },
  ],
  [
    'KVStore',
    () => {
      const data = new Map<string, string>();
      return new KVStore({ get: async (key) => data.get(key) ?? null, put: async (key, value) => void data.set(key, value), delete: async (key) => void data.delete(key) });
    },
  ],
];

const lookup = defineTool({ name: 'lookup', description: 'look up', input: z.object({ q: z.string() }), execute: async ({ q }) => `result for ${q}` });
const sendEmail = defineTool({ name: 'send_email', description: 'send', input: z.object({}), needsApproval: true, execute: async () => 'sent' });
const script: MockTurn[] = [{ toolCalls: [{ name: 'lookup', id: 'c1', args: { q: 'x' } }] }, 'It is x.', 'Bye.'];

describe.each(stores)('session.fork() on %s', (_name, makeStore) => {
  it('lists the steps, forks under <id>-fork-<n>, and a new agent continues the fork from the store', async () => {
    const store = makeStore();
    const agent = createAgent({ provider: mockModel([...script, 'branch']), tools: [lookup], store });
    const session = agent.session({ id: 'chat' });
    await session.send('find x');
    await session.send('thanks');
    expect((await session.history()).map(({ step, turn, text }) => [step, turn, text])).toEqual([
      [1, 0, ''],
      [2, 0, 'It is x.'],
      [3, 1, 'Bye.'],
    ]);

    const fork = await session.fork({ fromStep: 2 });
    expect(fork.id).toBe('chat-fork-1');
    expect((await session.fork({ fromStep: 1 })).id).toBe('chat-fork-2');
    expect(await store.sessions.load('chat')).toHaveLength(6);

    const model = mockModel(['from the store']);
    const reopened = createAgent({ provider: model, tools: [lookup], store }).session({ id: fork.id });
    expect((await reopened.send('more?')).text).toBe('from the store');
    expect(model.calls[0].messages.filter((m) => m.role !== 'system').map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
    await expect(session.fork({ fromStep: 0, id: fork.id })).rejects.toMatchObject({ code: 'LOUSHO_SESSION_EXISTS' });
  });

  it('skips a default id whose next turn already has a checkpoint', async () => {
    const store = makeStore();
    const agent = createAgent({ provider: mockModel(['hello']), store });
    const session = agent.session({ id: 'src' });
    await session.send('hi');
    await store.checkpoints.save('src-fork-1.turn-2', makeCheckpoint({ sessionId: 'src-fork-1.turn-2' }));
    expect((await session.fork({ fromStep: 1 })).id).toBe('src-fork-2');
  });

  it('leaves a paused turn and its approval with the source', async () => {
    const store = makeStore();
    const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'send_email', id: 'e1' }] }, 'fork reply', 'Email sent.']), tools: [sendEmail], store });
    const session = agent.session({ id: 'paused' });
    const paused = await session.send('email it');
    expect(paused.finishReason).toBe('awaiting-approval');

    const fork = await session.fork({ fromStep: 0 });
    expect(await fork.pending()).toBeNull();
    expect((await fork.send('never mind')).text).toBe('fork reply');
    expect((await agent.approvals.resolve({ id: paused.approvalId!, approved: true })).text).toBe('Email sent.');
    expect((await session.history()).at(-1)?.text).toBe('Email sent.');
    expect((await fork.history()).map((s) => s.text)).toEqual(['fork reply']);
  });
});
