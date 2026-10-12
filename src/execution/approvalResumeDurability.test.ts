/**
 * An approval resume keeps the paused run's checkpoint until the approved call's
 * result is saved (a crash mid-call neither loses the turn nor re-runs the call
 * silently), and refuses a stale approval whose run no longer waits on it.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { PropagatingToolError } from './AgentExecutor';
import { mockModel, type MockRequest } from '../testing';
import { memoryStore, type AgentStore } from '../storage/agentStore';
import { fileStore } from '../storage/fileStore';
import { SqliteStore } from '../storage/sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Checkpoint, CheckpointStore } from './checkpoint';

const lastToolResult = (request: MockRequest | undefined) => JSON.parse(String([...(request?.messages ?? [])].reverse().find((m) => m.role === 'tool')?.content));

describe('approval resume durability', () => {
  it('an approved call that dies before its result is saved is reported as interrupted on resume, not lost and not run again', async () => {
    const store = memoryStore();
    let runs = 0;
    const deploy = defineTool({
      name: 'deploy',
      description: 'deploy',
      input: z.object({}),
      needsApproval: true,
      execute: async () => {
        runs++;
        throw new PropagatingToolError('process died while deploying');
      },
    });
    const first = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'deploy', id: 'call_deploy' }] }]), tools: [deploy], store });
    const paused = await first.session({ id: 's1' }).send('deploy please');
    await expect(first.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toThrow('process died');

    expect(await first.pending()).toMatchObject([{ sessionId: 's1', status: 'in-progress' }]);
    const model = mockModel(['It may not have deployed; please check.']);
    const second = createAgent({ provider: model, tools: [deploy], store });
    const resumed = await second.session({ id: 's1' }).resume();

    expect(resumed?.text).toBe('It may not have deployed; please check.');
    expect(runs).toBe(1);
    expect(lastToolResult(model.calls[0])).toMatchObject({ kind: 'interrupted', toolName: 'deploy' });
    const transcript = await second.session({ id: 's1' }).load();
    expect(transcript.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(await second.pending()).toEqual([]);
  });

  it('a stale approval does not come back after its run was deleted and a newer conversation took the id', async () => {
    const store = memoryStore();
    let refunds = 0;
    const refund = defineTool({ name: 'refund', description: 'refund', input: z.object({}), needsApproval: true, execute: async () => `refunded ${++refunds}` });
    const agent = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'refund', id: 'call_refund' }] }, 'hi there', 'refund done'], { onExhausted: 'repeat-last' }),
      tools: [refund],
      store,
    });
    const paused = await agent.send('refund me', { sessionId: 'chat' });
    await store.checkpoints.delete('chat'); // "start over under the same id"
    await agent.send('hello', { sessionId: 'chat' });
    const fresh = await store.checkpoints.load('chat');

    await expect(agent.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toMatchObject({ code: 'LOUSHO_APPROVAL_ORPHANED' });
    expect(refunds).toBe(0);
    expect(await store.checkpoints.load('chat')).toEqual(fresh);
    expect(await agent.approvals.list()).toEqual([]);
    await expect(agent.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toMatchObject({ code: 'LOUSHO_APPROVAL_NOT_FOUND' });
  });

  it("discardPending() withdraws the dropped turn's approvals", async () => {
    const store = memoryStore();
    const refund = defineTool({ name: 'refund', description: 'refund', input: z.object({}), needsApproval: true, execute: async () => 'refunded' });
    const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'refund', id: 'call_refund' }] }]), tools: [refund], store });
    const session = agent.session({ id: 's1' });
    const paused = await session.send('refund me');
    expect((await agent.approvals.list()).map((approval) => approval.id)).toEqual([paused.approvalId]);

    await session.discardPending();

    expect(await agent.approvals.list()).toEqual([]);
    await expect(agent.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toMatchObject({ code: 'LOUSHO_APPROVAL_NOT_FOUND' });
  });
});

/** `store` whose checkpoints' next fenced save (once armed) fails like a disk error, before writing anything. */
function failingFencedSave(store: AgentStore): { store: AgentStore; arm: () => void } {
  const checkpoints = store.checkpoints as CheckpointStore;
  let armed = false;
  const failing = new Proxy(checkpoints, {
    get(target, key) {
      if (key === 'saveIfLeased') {
        return async (id: string, checkpoint: Checkpoint, owner: string) => {
          if (armed) {
            armed = false;
            throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
          }
          return target.saveIfLeased!(id, checkpoint, owner);
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { store: { ...store, checkpoints: failing }, arm: () => (armed = true) };
}

const stores: Array<[string, () => { store: AgentStore; done: () => void }]> = [
  ['memoryStore', () => ({ store: memoryStore(), done: () => undefined })],
  [
    'fileStore',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'lousho-resume-'));
      return { store: fileStore(dir), done: () => rmSync(dir, { recursive: true, force: true }) };
    },
  ],
  [
    'SqliteStore',
    () => {
      const sqlite = new SqliteStore(':memory:');
      return { store: sqlite, done: () => sqlite.close() };
    },
  ],
];

describe.each(stores)('approval resume recovery (%s)', (_name, open) => {
  const refundAgent = (store: AgentStore, counter: { runs: number }) => {
    const refund = defineTool({ name: 'refund', description: 'refund', input: z.object({}), needsApproval: true, execute: async () => `refunded ${++counter.runs}` });
    return createAgent({ provider: mockModel([{ toolCalls: [{ name: 'refund', id: 'call_refund' }] }, 'done'], { onExhausted: 'repeat-last' }), tools: [refund], store });
  };

  it('a storage error while the resume marks the run puts the approval back: deciding again runs the tool once (run mode)', async () => {
    const { store: base, done } = open();
    try {
      const { store, arm } = failingFencedSave(base);
      const counter = { runs: 0 };
      const agent = refundAgent(store, counter);
      const paused = await agent.send('refund me', { sessionId: 'run-1' });
      arm();
      await expect(agent.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toThrow('EIO');
      expect(counter.runs).toBe(0);
      expect((await agent.approvals.list()).map((approval) => approval.id)).toEqual([paused.approvalId]);

      const resumed = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
      expect(resumed.finishReason).toBe('stop');
      expect(counter.runs).toBe(1);
    } finally {
      done();
    }
  });

  it('a storage error while the resume marks the run puts the approval back (session mode)', async () => {
    const { store: base, done } = open();
    try {
      const { store, arm } = failingFencedSave(base);
      const counter = { runs: 0 };
      const agent = refundAgent(store, counter);
      const paused = await agent.session({ id: 's1' }).send('refund me');
      arm();
      await expect(agent.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toThrow('EIO');
      expect(await agent.session({ id: 's1' }).pending()).toMatchObject({ status: 'awaiting-approval', approvalId: paused.approvalId });

      await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
      expect(counter.runs).toBe(1);
      expect((await agent.session({ id: 's1' }).load()).at(-1)).toMatchObject({ role: 'assistant', content: 'done' });
    } finally {
      done();
    }
  });

  it('a run whose approval was claimed by a resolver that died before marking it pauses again on resume() (run mode)', async () => {
    const { store, done } = open();
    try {
      const counter = { runs: 0 };
      const agent = refundAgent(store, counter);
      const paused = await agent.send('refund me', { sessionId: 'run-1' });
      await store.approvals!.resolve(paused.approvalId!); // claimed, then the process died
      await expect(agent.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toMatchObject({ code: 'LOUSHO_APPROVAL_NOT_FOUND' });

      const again = await agent.resume('run-1');
      expect(again?.finishReason).toBe('awaiting-approval');
      expect(again?.approvalId).toBeDefined();
      expect(again?.approvalId).not.toBe(paused.approvalId);
      expect(counter.runs).toBe(0);
      expect((await agent.approvals.list()).map((approval) => approval.id)).toEqual([again?.approvalId]);

      const resumed = await agent.approvals.resolve({ id: again!.approvalId!, approved: true });
      expect(resumed.finishReason).toBe('stop');
      expect(counter.runs).toBe(1);
    } finally {
      done();
    }
  });

  it('a session turn whose approval was claimed by a resolver that died pauses again, and send() then names the new approval', async () => {
    const { store, done } = open();
    try {
      const counter = { runs: 0 };
      const agent = refundAgent(store, counter);
      const paused = await agent.session({ id: 's1' }).send('refund me');
      await store.approvals!.resolve(paused.approvalId!);

      const error = await agent
        .session({ id: 's1' })
        .send('hello?')
        .then(
          () => undefined,
          (thrown: unknown) => thrown as { code?: string; approvalId?: string }
        );
      expect(error).toMatchObject({ code: 'LOUSHO_SESSION_AWAITING_APPROVAL' });
      expect(error?.approvalId).not.toBe(paused.approvalId);
      expect(counter.runs).toBe(0);
      await agent.approvals.resolve({ id: error!.approvalId!, approved: true });
      expect(counter.runs).toBe(1);
    } finally {
      done();
    }
  });

  it('the resume holds the run lease before it claims the approval, so a live run elsewhere leaves the approval pending', async () => {
    const { store, done } = open();
    try {
      const counter = { runs: 0 };
      const agent = refundAgent(store, counter);
      const paused = await agent.send('refund me', { sessionId: 'run-1' });
      expect(await store.checkpoints!.acquireLease!('run-1', 'claim:elsewhere', 60_000)).toBe(true);
      await expect(agent.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toMatchObject({ code: 'LOUSHO_SESSION_BUSY' });
      expect((await agent.approvals.list()).map((approval) => approval.id)).toEqual([paused.approvalId]);
      expect(counter.runs).toBe(0);
    } finally {
      done();
    }
  });
});
