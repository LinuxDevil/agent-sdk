/**
 * Eve DUR-F6: `SqliteStore.prune()` keeps a session turn that is paused on an
 * unresolved approval (its checkpoint and its session's transcript), and a
 * paused turn whose checkpoint is gone anyway fails with
 * `LOUSHO_APPROVAL_ORPHANED` instead of running the approved tool.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../../createAgent';
import { defineTool } from '../../tools/defineTool';
import { mockModel, type MockTurn } from '../../testing';
import { SqliteStore } from './index';

const stores: SqliteStore[] = [];
afterEach(() => {
  while (stores.length) stores.pop()?.close();
});

const AGE = 10 * 60 * 1000;

function setup() {
  const store = new SqliteStore(':memory:');
  stores.push(store);
  const { tools, refunds } = refundTools();
  const turns: MockTurn[] = ['hi there', { toolCalls: [{ name: 'refund', args: { amount: 40 } }] }, 'Refund sent.'];
  const agent = createAgent({ provider: mockModel(turns), tools, store });
  return { store, agent, refunds };
}

function refundTools() {
  const refunds: number[] = [];
  const tools = [
    defineTool({
      name: 'refund',
      description: 'refund an order',
      input: z.object({ amount: z.number() }),
      needsApproval: true,
      execute: async ({ amount }) => {
        refunds.push(amount);
        return 'refunded';
      },
    }),
  ];
  return { tools, refunds };
}

/** Makes every row look `AGE` old, as if the store had sat untouched over a long weekend. */
function age(store: SqliteStore): void {
  const db = store.connection.db;
  db.prepare('UPDATE sessions SET updated_at = updated_at - ?').run(AGE);
  db.prepare('UPDATE checkpoints SET updated_at = updated_at - ?').run(AGE);
  db.prepare('UPDATE checkpoint_history SET saved_at = saved_at - ?').run(AGE);
  db.prepare('UPDATE approvals SET updated_at = updated_at - ?').run(AGE);
}

describe('SqliteStore.prune() and paused turns (Eve DUR-F6)', () => {
  it('keeps the checkpoint and transcript of a turn paused on an unresolved approval', async () => {
    const { store, agent, refunds } = setup();
    const session = agent.session({ id: 'cust-7' });
    await session.send('hello');
    const paused = await session.send('refund my order');
    expect(paused.finishReason).toBe('awaiting-approval');
    await store.sessions.save('stale', [{ role: 'user', content: 'old' }]);
    age(store);

    expect(store.prune({ olderThanMs: 60 * 1000 })).toEqual({ sessions: 1, checkpoints: 0, approvals: 0, oauthPending: 0 });
    expect(await store.sessions.load('stale')).toBeUndefined();

    const fresh = agent.session({ id: 'cust-7' });
    expect((await fresh.pending())?.status).toBe('awaiting-approval');
    expect(await fresh.load()).toHaveLength(2);

    const done = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(done.text).toBe('Refund sent.');
    expect(refunds).toEqual([40]);
    expect(await store.sessions.load('cust-7')).toHaveLength(6);
  });

  it('prunes the turn once its approval is resolved', async () => {
    const { store, agent } = setup();
    const session = agent.session({ id: 'cust-7' });
    await session.send('hello');
    const paused = await session.send('refund my order');
    await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    age(store);
    store.connection.db.prepare('UPDATE approvals SET resolved_at = resolved_at - ?').run(AGE);

    expect(store.prune({ olderThanMs: 60 * 1000 })).toMatchObject({ sessions: 1, approvals: 1 });
    expect(await store.sessions.load('cust-7')).toBeUndefined();
  });

  it('fails with LOUSHO_APPROVAL_ORPHANED, without running the tool, when the paused turn is gone', async () => {
    const { store, agent, refunds } = setup();
    const session = agent.session({ id: 'cust-7' });
    await session.send('hello');
    const paused = await session.send('refund my order');
    await store.checkpoints.delete('cust-7.turn-2');

    await expect(agent.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toMatchObject({ code: 'LOUSHO_APPROVAL_ORPHANED' });
    expect(refunds).toEqual([]);
    expect(await store.sessions.load('cust-7')).toHaveLength(2);
  });

  it('fails the same way for a resolve from a restarted process (a cold session)', async () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const { tools, refunds } = refundTools();
    const first = createAgent({ provider: mockModel(['hi', { toolCalls: [{ name: 'refund', args: { amount: 40 } }] }]), tools, store });
    const session = first.session({ id: 'cust-7' });
    await session.send('hello');
    const paused = await session.send('refund my order');
    await store.checkpoints.delete('cust-7.turn-2');

    const restarted = createAgent({ provider: mockModel(['Refund sent.', 'Refund sent.']), tools, store });
    await expect(restarted.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toMatchObject({ code: 'LOUSHO_APPROVAL_ORPHANED' });
    const run = restarted.approvals.streamResolve({ id: paused.approvalId!, approved: true });
    await expect(run.result).rejects.toMatchObject({ code: 'LOUSHO_APPROVAL_ORPHANED' });
    expect(refunds).toEqual([]);
  });
});
