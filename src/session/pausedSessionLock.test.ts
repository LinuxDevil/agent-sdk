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
    // Eve3-S4: turn numbering is monotonic - the earlier 'hi' turn took turn-0, so this pause is turn-2.
    expect(await store.checkpoints.load('chat.turn-2')).toMatchObject({ status: 'awaiting-approval' });

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

  it('a missing .paused marker still locks the session: the turn checkpoint itself says it waits (Eve2-F3)', async () => {
    const store = memoryStore();
    const model = mockModel([calling('restart'), 'resumed']);
    const agent = createAgent({ provider: model, tools: [restart({ n: 0 })], store });
    const paused = await agent.session({ id: 'chat', store: new MemorySessionStore() }).send('restart it');
    expect(paused.finishReason).toBe('awaiting-approval');
    // A crash between the executor's awaiting-approval checkpoint and markPaused() leaves no pointer, permanently.
    await store.checkpoints.delete('chat.paused');
    expect(await store.checkpoints.load('chat.paused')).toBeNull();

    await expect(agent.send('unrelated work', { sessionId: 'chat' })).rejects.toMatchObject({
      name: 'SessionAwaitingApprovalError',
      code: 'LOUSHO_SESSION_AWAITING_APPROVAL',
      approvalId: paused.approvalId,
      sessionId: 'chat.turn-0',
    });
    const durable = agent.session({ id: 'chat' });
    expect(await durable.pending()).toMatchObject({ status: 'awaiting-approval', approvalId: paused.approvalId });
    await expect(durable.send('more work')).rejects.toMatchObject({ code: 'LOUSHO_SESSION_AWAITING_APPROVAL' });
    expect(model.calls).toHaveLength(1);
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

  // Eve3-S1: without a checkpointStore the pause had no marker, so send()/compact() ran beside it and the resumed
  // turn clobbered whatever they committed. An in-process marker on (store, id) closes that gap.
  it('a paused non-checkpointed turn refuses send() and compact(), and resolve() keeps both turns', async () => {
    const store = memoryStore();
    const runs = { n: 0 };
    const transcripts = new MemorySessionStore();
    const model = mockModel([calling('restart'), 'Restarted.', 'After.']);
    const agent = createAgent({ provider: model, tools: [restart(runs)], store });
    const session = agent.session({ id: 'chat', store: transcripts }); // no checkpointStore
    const paused = await session.send('restart it');
    expect(paused.finishReason).toBe('awaiting-approval');

    await expect(session.send('unrelated work')).rejects.toMatchObject({ code: 'LOUSHO_SESSION_AWAITING_APPROVAL', approvalId: paused.approvalId });
    await expect(session.compact()).rejects.toMatchObject({ code: 'LOUSHO_SESSION_AWAITING_APPROVAL' });
    await expect(session.clear()).rejects.toMatchObject({ code: 'LOUSHO_SESSION_AWAITING_APPROVAL' });
    expect(await session.pending()).toMatchObject({ status: 'awaiting-approval', approvalId: paused.approvalId });
    expect(model.calls).toHaveLength(1); // the refused send ran no turn

    expect((await agent.approvals.resolve({ id: paused.approvalId!, approved: true })).text).toBe('Restarted.');
    expect(runs.n).toBe(1);
    expect(await session.pending()).toBeNull();
    expect((await session.send('and now?')).text).toBe('After.');
    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user', 'assistant']);
  });

  it('discardPending() drops an in-memory pause and withdraws its approval', async () => {
    const runs = { n: 0 };
    const transcripts = new MemorySessionStore();
    const agent = createAgent({ provider: mockModel([calling('restart'), 'fresh']), tools: [restart(runs)], store: memoryStore() });
    const session = agent.session({ id: 'chat', store: transcripts });
    const paused = await session.send('restart it');

    await session.discardPending();
    expect(await session.pending()).toBeNull();
    await expect(agent.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toThrow();
    expect((await session.send('something else')).text).toBe('fresh');
    expect(runs.n).toBe(0);
  });
});
