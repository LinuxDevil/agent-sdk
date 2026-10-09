/**
 * Eve EVE-0 follow-up: a session turn paused for approval is a lock on the
 * session. A new turn under its id - `agent.send(msg, { sessionId })`, or a
 * session whose transcript is a different length than the one the paused turn
 * started from - fails with `SessionAwaitingApprovalError` until the approval
 * is decided or the turn is discarded.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { SessionAwaitingApprovalError } from '../execution/errors';
import { memoryStore } from '../storage/agentStore';
import { mockModel } from '../testing';
import { MemorySessionStore } from './index';

const calling = (name: string) => ({ toolCalls: [{ name, id: `call_${name}`, args: {} }] });

function restart(runs: { n: number }) {
  return defineTool({
    name: 'restart',
    description: 'restart a service',
    input: z.object({}),
    needsApproval: true,
    execute: async () => {
      runs.n++;
      return 'restarted';
    },
  });
}

describe('a paused session turn locks the session (Eve EVE-0 follow-up)', () => {
  it('agent.send(msg, { sessionId }) refuses while a turn of that session awaits approval', async () => {
    const store = memoryStore();
    const model = mockModel([calling('restart'), 'second-turn-ok']);
    const agent = createAgent({ provider: model, tools: [restart({ n: 0 })], store });
    const paused = await agent.session({ id: 'chat', store: new MemorySessionStore() }).send('restart it');
    expect(paused.finishReason).toBe('awaiting-approval');

    await expect(agent.send('unrelated work', { sessionId: 'chat' })).rejects.toMatchObject({
      name: 'SessionAwaitingApprovalError',
      code: 'LOUSHO_SESSION_AWAITING_APPROVAL',
      approvalId: paused.approvalId,
      sessionId: 'chat.turn-0',
    });
    expect(() => agent.stream('unrelated work', { sessionId: 'chat' })).not.toThrow();
    await expect(agent.stream('unrelated work', { sessionId: 'chat' }).result).rejects.toBeInstanceOf(SessionAwaitingApprovalError);
    expect(model.calls).toHaveLength(1);
    expect(await store.checkpoints.load('chat')).toBeNull();
  });

  it('a session whose transcript differs from the paused turn\'s still finds the pause, and refuses new turns', async () => {
    const store = memoryStore();
    await createAgent({ provider: mockModel(['done']), store }).session({ id: 'chat' }).send('hi');
    const runs = { n: 0 };
    const model = mockModel([calling('restart'), 'resumed', 'after']);
    const agent = createAgent({ provider: model, tools: [restart(runs)], store });
    const paused = await agent.session({ id: 'chat', store: new MemorySessionStore() }).send('restart it');
    expect(await store.checkpoints.load('chat.turn-0')).toMatchObject({ status: 'awaiting-approval' });

    const durable = agent.session({ id: 'chat' });
    expect(await durable.pending()).toEqual({ status: 'awaiting-approval', approvalId: paused.approvalId });
    await expect(durable.send('more work')).rejects.toMatchObject({ code: 'LOUSHO_SESSION_AWAITING_APPROVAL', approvalId: paused.approvalId });
    await expect(durable.resume()).rejects.toBeInstanceOf(SessionAwaitingApprovalError);
    await expect(agent.resume('chat')).rejects.toBeInstanceOf(SessionAwaitingApprovalError);
    expect(model.calls).toHaveLength(1);
    expect((await store.sessions!.load('chat'))!.length).toBe(2);
  });

  it('discardPending() drops the paused turn and unlocks the session', async () => {
    const store = memoryStore();
    const model = mockModel([calling('restart'), 'fresh']);
    const agent = createAgent({ provider: model, tools: [restart({ n: 0 })], store });
    await agent.session({ id: 'chat', store: new MemorySessionStore() }).send('restart it');

    const durable = agent.session({ id: 'chat' });
    await durable.discardPending();
    expect(await durable.pending()).toBeNull();
    expect(await store.checkpoints.load('chat.turn-0')).toBeNull();
    expect((await durable.send('something else')).text).toBe('fresh');
  });

  it('once the approval is decided the session takes new turns again', async () => {
    const store = memoryStore();
    const runs = { n: 0 };
    const agent = createAgent({ provider: mockModel([calling('restart'), 'Restarted.', 'Next.']), tools: [restart(runs)], store });
    const session = agent.session({ id: 'chat' });
    const paused = await session.send('restart it');
    await expect(agent.send('x', { sessionId: 'chat' })).rejects.toBeInstanceOf(SessionAwaitingApprovalError);

    expect((await agent.approvals.resolve({ id: paused.approvalId!, approved: true })).text).toBe('Restarted.');
    expect(runs.n).toBe(1);
    expect(await session.pending()).toBeNull();
    expect((await session.send('and now?')).text).toBe('Next.');
  });
});
