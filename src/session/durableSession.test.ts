/**
 * LOU-W9: checkpointed sessions. Every turn is checkpointed per step, so a
 * turn interrupted mid-way (a crash, a failed checkpoint write) is finished
 * by `session.resume()` in a fresh agent, without re-running finished steps.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { PropagatingToolError } from '../execution/AgentExecutor';
import { SessionAwaitingApprovalError } from '../execution/errors';
import { InMemoryApprovalStore } from '../execution/InMemoryApprovalStore';
import { KVCheckpointStore } from '../deploy/kvCheckpointStore';
import { SqliteStore } from '../storage/sqlite';
import { mockModel, type MockTurn } from '../testing';
import { MemorySessionStore } from './index';
import type { AgentRun } from '../execution/agentRun';
import type { Message } from '../providers/llm';

type Runs = Record<string, number>;

/** A tool that counts its runs and, with `crashOnce`, dies (PropagatingToolError) on its first run. */
function tool(name: string, runs: Runs, options: { crashOnce?: boolean; needsApproval?: boolean } = {}): DefinedTool {
  runs[name] = 0;
  return defineTool({
    name,
    description: name,
    input: z.object({}),
    needsApproval: options.needsApproval,
    execute: async () => {
      runs[name]++;
      if (options.crashOnce && runs[name] === 1) throw new PropagatingToolError(`process died while running ${name}`);
      return `${name} done`;
    },
  });
}

/** A KVCheckpointStore over a Map (JSON round-trip), optionally failing the n-th save (1-based). */
function checkpointStore(failSave?: number): KVCheckpointStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  let saves = 0;
  const store = new KVCheckpointStore({
    get: async (key) => data.get(key) ?? null,
    put: async (key, value) => {
      saves++;
      if (saves === failSave) throw new Error('disk gone');
      data.set(key, value);
    },
    delete: async (key) => {
      data.delete(key);
    },
  });
  return Object.assign(store, { data });
}

const calling = (name: string): MockTurn => ({ toolCalls: [{ name, id: `call_${name}` }] });
const roles = (messages: readonly { role: string }[]): string[] => messages.map((m) => m.role);
const users = (messages: readonly Message[]): number => messages.filter((m) => m.role === 'user').length;
const fullTurn = ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'];

async function drain(run: AgentRun): Promise<void> {
  for await (const event of run) void event;
}

describe('checkpointed sessions (LOU-W9)', () => {
  it('resume() finishes a turn that crashed on its second step, in a fresh agent, without re-running finished steps', async () => {
    const runs: Runs = {};
    const tools = [tool('a', runs), tool('b', runs, { crashOnce: true })];
    const sessions = new MemorySessionStore();
    const checkpoints = checkpointStore();

    const first = mockModel([calling('a'), calling('b'), 'never reached']);
    const crashed = createAgent({ provider: first, tools }).session({ id: 'chat', store: sessions, checkpointStore: checkpoints });
    await expect(crashed.send('do a then b')).rejects.toThrow('process died');
    expect(first.calls).toHaveLength(2);
    expect(await sessions.load('chat')).toBeUndefined();
    expect([...checkpoints.data.keys()]).toEqual(['checkpoints/chat.turn-0']);

    const second = mockModel(['All done.']);
    const session = createAgent({ provider: second, tools }).session({ id: 'chat', store: sessions, checkpointStore: checkpoints });
    expect(await session.pending()).toEqual({ status: 'in-progress', approvalId: undefined });

    const result = await session.resume();

    expect(result?.text).toBe('All done.');
    expect(second.calls).toHaveLength(1);
    expect(runs).toEqual({ a: 1, b: 2 }); // `a` was recorded; `b` was running when the process died
    const saved = (await sessions.load('chat'))!;
    expect(roles(saved)).toEqual(fullTurn);
    expect(users(saved)).toBe(1);
    expect(session.messages).toEqual(saved);
    expect(checkpoints.data.size).toBe(0);
    expect(await session.pending()).toBeNull();
    expect(await session.resume()).toBeNull();
  });

  it('a failed checkpoint write is resumed from a { sessions, checkpoints } store without calling the model again', async () => {
    const runs: Runs = {};
    const tools = [tool('a', runs)];
    const store = { sessions: new MemorySessionStore(), checkpoints: checkpointStore(2) }; // save 2 = `a`'s result

    const first = mockModel([calling('a'), 'never reached']);
    await expect(createAgent({ provider: first, tools }).session({ id: 'chat', store }).send('do a')).rejects.toThrow('disk gone');

    const second = mockModel(['Done.']);
    const result = await createAgent({ provider: second, tools }).session({ id: 'chat', store }).resume();

    expect(result?.text).toBe('Done.');
    expect(second.calls).toHaveLength(1);
    expect(runs.a).toBe(2);
    expect(roles((await store.sessions.load('chat'))!)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('send() while a turn is pending finishes that turn first, then sends the new message', async () => {
    const runs: Runs = {};
    const tools = [tool('a', runs), tool('b', runs, { crashOnce: true })];
    const store = { sessions: new MemorySessionStore(), checkpoints: checkpointStore() };
    await expect(
      createAgent({ provider: mockModel([calling('a'), calling('b')]), tools }).session({ id: 'chat', store }).send('first')
    ).rejects.toThrow('process died');

    const model = mockModel(['First done.', 'Second done.']);
    const session = createAgent({ provider: model, tools }).session({ id: 'chat', store });
    const result = await session.send('second');

    expect(result.text).toBe('Second done.');
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1].messages.at(-1)).toMatchObject({ role: 'user', content: 'second' });
    expect(roles(session.messages)).toEqual([...fullTurn, 'user', 'assistant']);
    expect(store.checkpoints.data.size).toBe(0);
  });

  it('stream() checkpoints its turn too, and a fresh session resumes it', async () => {
    const runs: Runs = {};
    const tools = [tool('a', runs), tool('b', runs, { crashOnce: true })];
    const store = { sessions: new MemorySessionStore(), checkpoints: checkpointStore() };

    const ok = createAgent({ provider: mockModel(['Hi.']) }).session({ id: 'chat', store });
    await drain(ok.stream('hello'));
    expect(store.checkpoints.data.size).toBe(0); // a finished turn leaves no checkpoint

    const crashing = createAgent({ provider: mockModel([calling('a'), calling('b')]), tools }).session({ id: 'chat', store });
    const run = crashing.stream('do a then b');
    await drain(run);
    await expect(run.result).rejects.toThrow('process died');
    expect([...store.checkpoints.data.keys()]).toEqual(['checkpoints/chat.turn-2']);

    const model = mockModel(['All done.']);
    const result = await createAgent({ provider: model, tools }).session({ id: 'chat', store }).resume();

    expect(result?.text).toBe('All done.');
    expect(model.calls).toHaveLength(1);
    expect(roles((await store.sessions.load('chat'))!)).toEqual(['user', 'assistant', ...fullTurn]);
  });

  it('an approval pause survives a restart and resolves through agent.approvals.resolve()', async () => {
    const runs: Runs = {};
    const tools = [tool('send_email', runs, { needsApproval: true })];
    const store = new SqliteStore(':memory:');
    const approvalStore = new InMemoryApprovalStore();

    const before = createAgent({ provider: mockModel([calling('send_email')]), tools, approvalStore }).session({ id: 'chat', store });
    const paused = await before.send('Email Sam');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(before.messages).toEqual([]); // the paused turn lives in its checkpoint until it finishes
    await expect(before.send('anything else?')).rejects.toBeInstanceOf(SessionAwaitingApprovalError);

    const model = mockModel(['Email sent.']);
    const agent = createAgent({ provider: model, tools, approvalStore });
    const session = agent.session({ id: 'chat', store });
    expect(await session.pending()).toEqual({ status: 'awaiting-approval', approvalId: paused.approvalId });
    await expect(session.resume()).rejects.toMatchObject({ name: 'SessionAwaitingApprovalError', approvalId: paused.approvalId });

    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(result.text).toBe('Email sent.');
    expect(runs.send_email).toBe(1);
    expect(model.calls).toHaveLength(1);
    expect(roles(session.messages)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(roles((await store.sessions.load('chat'))!)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(await session.pending()).toBeNull();
    store.close();
  });

  it('a turn that finished just before its transcript was saved is added to the transcript, not run again', async () => {
    const sessions = new MemorySessionStore();
    const checkpoints = checkpointStore();
    const failing = Object.assign(Object.create(sessions) as MemorySessionStore, {
      save: async () => {
        throw new Error('session store gone');
      },
    });
    const model = mockModel(['Hi.']);
    await expect(createAgent({ provider: model }).session({ id: 'chat', store: failing, checkpointStore: checkpoints }).send('hello')).rejects.toThrow(
      'session store gone'
    );

    const session = createAgent({ provider: mockModel([]) }).session({ id: 'chat', store: sessions, checkpointStore: checkpoints });
    expect(await session.resume()).toBeNull();
    expect(roles(session.messages)).toEqual(['user', 'assistant']);
    expect(roles((await sessions.load('chat'))!)).toEqual(['user', 'assistant']);
    expect(checkpoints.data.size).toBe(0);
  });

  it('an aborted turn, discardPending() and clear() leave no pending turn', async () => {
    const runs: Runs = {};
    const tools = [tool('a', runs), tool('b', runs, { crashOnce: true })];
    const store = { sessions: new MemorySessionStore(), checkpoints: checkpointStore() };
    const session = createAgent({ provider: mockModel([calling('a'), calling('b'), calling('a'), calling('b')]), tools }).session({ id: 'chat', store });

    const aborted = await session.send('go', { signal: AbortSignal.abort() });
    expect(aborted.finishReason).toBe('aborted');
    expect(await session.pending()).toBeNull();

    await expect(session.send('go')).rejects.toThrow('process died');
    expect(await session.pending()).toMatchObject({ status: 'in-progress' });
    await session.discardPending();
    expect(await session.pending()).toBeNull();
    expect(session.messages).toEqual([]);

    runs.b = 0;
    await expect(session.send('go')).rejects.toThrow('process died');
    await session.clear();
    expect(store.checkpoints.data.size).toBe(0);
  });
});
