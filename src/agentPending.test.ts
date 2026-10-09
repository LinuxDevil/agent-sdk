/**
 * Eve DUR-F15: `agent.pending()` lists the runs a crash or a pause left
 * unfinished across sessions, so a restarted process can find and resume them.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgent } from './createAgent';
import { defineTool, type DefinedTool } from './tools/defineTool';
import { PropagatingToolError } from './execution/AgentExecutor';
import { fileStore } from './storage/fileStore';
import { memoryStore, type AgentStore } from './storage/agentStore';
import { SqliteStore } from './storage/sqlite';
import { MemorySessionStore } from './session/sessionStore';
import { mockModel, type MockTurn } from './testing';

const calling = (name: string, id = `call_${name}`): MockTurn => ({ toolCalls: [{ name, id }] });

function tools(runs: Record<string, number>): DefinedTool[] {
  runs.work ??= 0;
  runs.send_email ??= 0;
  return [
    defineTool({
      name: 'work',
      description: 'work',
      input: z.object({}),
      execute: async () => {
        runs.work++;
        if (runs.work === 1) throw new PropagatingToolError('process died');
        return 'worked';
      },
    }),
    defineTool({ name: 'send_email', description: 'email', input: z.object({}), needsApproval: true, execute: async () => `sent ${++runs.send_email}` }),
  ];
}

const dirs: string[] = [];
const closers: Array<{ close(): void }> = [];
afterEach(() => {
  while (closers.length) closers.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-pending-'));
  dirs.push(dir);
  return dir;
};

const kinds: Array<[string, () => () => AgentStore]> = [
  [
    'fileStore',
    () => {
      const dir = tempDir();
      return () => fileStore(dir);
    },
  ],
  [
    'SqliteStore',
    () => {
      const path = join(tempDir(), 'agent.db');
      return () => {
        const store = new SqliteStore(path);
        closers.push(store);
        return store;
      };
    },
  ],
  [
    'memoryStore (shared)',
    () => {
      const store = memoryStore();
      return () => store;
    },
  ],
];

describe('agent.pending() (Eve DUR-F15)', () => {
  for (const [name, setup] of kinds) {
    it(`${name}: lists interrupted and paused runs across sessions after a restart, and recovering empties it`, async () => {
      const mkStore = setup();
      const runs: Record<string, number> = {};
      const before = createAgent({ provider: mockModel([calling('work'), calling('send_email'), calling('work', 'call_w2')]), tools: tools(runs), store: mkStore() });

      await expect(before.session({ id: 'alice' }).send('do work')).rejects.toThrow('process died');
      const paused = await before.session({ id: 'bob' }).send('email');
      expect(paused.finishReason).toBe('awaiting-approval');
      // A finished run is not listed.
      const done = createAgent({ provider: mockModel(['ok']), tools: tools({}), store: mkStore() });
      await done.send('hi', { sessionId: 'job-1' });

      // "restart": a fresh agent over the same store.
      const after = createAgent({ provider: mockModel(['alice done', 'bob done']), tools: tools(runs), store: mkStore() });
      const pending = await after.pending();
      expect(pending).toEqual([
        {
          sessionId: 'alice',
          kind: 'session',
          checkpointId: 'alice.turn-0',
          status: 'in-progress',
          step: expect.any(Number),
          lastError: expect.objectContaining({ message: 'process died', retryable: true }),
        },
        {
          sessionId: 'bob',
          kind: 'session',
          checkpointId: 'bob.turn-0',
          status: 'awaiting-approval',
          approvalId: paused.approvalId,
          step: expect.any(Number),
        },
      ]);

      // The recovery recipe of docs/durable-execution.md.
      for (const run of pending) {
        if (run.status === 'in-progress') expect((await after.resume(run.sessionId))?.text).toBe('alice done');
        else expect((await after.approvals.resolve({ id: run.approvalId!, approved: true })).text).toBe('bob done');
      }
      expect(await after.pending()).toEqual([]);
      expect(runs).toMatchObject({ work: 2, send_email: 1 });
    });
  }

  it('lists an interrupted send(msg, { sessionId }) run as kind "run"', async () => {
    const store = memoryStore();
    const runs: Record<string, number> = {};
    const agent = createAgent({ provider: mockModel([calling('work'), 'finished']), tools: tools(runs), store });
    await expect(agent.send('do work', { sessionId: 'job-7' })).rejects.toThrow('process died');
    expect(await agent.pending()).toEqual([{ sessionId: 'job-7', kind: 'run', checkpointId: 'job-7', status: 'in-progress', step: expect.any(Number) }]);
    expect((await agent.resume('job-7'))?.text).toBe('finished');
    expect(await agent.pending()).toEqual([]);
  });

  it('throws without a checkpoint store, or with one that cannot list()', async () => {
    const bare = createAgent({ provider: mockModel(['x']) });
    await expect(bare.pending()).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_MISSING_CHECKPOINT_STORE' });
    const { checkpoints } = memoryStore();
    const noList = { save: checkpoints.save.bind(checkpoints), load: checkpoints.load.bind(checkpoints), delete: checkpoints.delete.bind(checkpoints) };
    const agent = createAgent({ provider: mockModel(['x']), store: { sessions: new MemorySessionStore(), checkpoints: noList } });
    await expect(agent.pending()).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
  });
});
