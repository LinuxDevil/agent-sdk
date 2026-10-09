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
import { memoryStore } from '../storage/agentStore';
import { mockModel, type MockStaticTurn } from '../testing';
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
  }, undefined, undefined, { historyLimit: 0 }); // these tests count puts as saves
  return Object.assign(store, { data });
}

const calling = (name: string): MockStaticTurn => ({ toolCalls: [{ name, id: `call_${name}` }] });
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

  it('clear() and compact() reject while a durable turn waits on an approval (LOU-W8)', async () => {
    const tools = [tool('send_email', {}, { needsApproval: true })];
    const store = new SqliteStore(':memory:');
    const session = createAgent({ provider: mockModel([calling('send_email')]), tools, approvalStore: new InMemoryApprovalStore() }).session({ id: 'chat', store });
    await session.send('Email Sam');

    await expect(session.clear()).rejects.toBeInstanceOf(SessionAwaitingApprovalError);
    await expect(session.compact()).rejects.toMatchObject({ code: 'LOUSHO_SESSION_AWAITING_APPROVAL' });
    expect(await session.pending()).toMatchObject({ status: 'awaiting-approval' });
    store.close();
  });

  it('a turn that finished just before its transcript was saved is added to the transcript, not run again', async () => {
    const sessions = new MemorySessionStore();
    const checkpoints = checkpointStore();
    const failing = Object.assign(Object.create(sessions) as MemorySessionStore, {
      save: async () => {
        throw new Error('session store gone');
      },
      saveIf: async () => {
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

  it('resolving a paused session turn from a fresh agent (session never opened) commits the turn', async () => {
    // coding-agent F1: a restarted process had an empty `sessions` map, so
    // resolve() resumed outside the session and the turn never joined the
    // transcript.
    const runs: Runs = {};
    const tools = [tool('write_file', runs, { needsApproval: true })];
    const store = memoryStore();
    const before = createAgent({ provider: mockModel([calling('write_file'), 'never used']), tools, store });
    const paused = await before.session({ id: 'chat' }).send('update a.txt');
    expect(paused.finishReason).toBe('awaiting-approval');

    const after = createAgent({ provider: mockModel(['Wrote it.']), tools, store });
    expect(await after.approvals.get(paused.approvalId!)).toMatchObject({ toolName: 'write_file' });
    const resolved = await after.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(resolved.text).toBe('Wrote it.');
    expect(runs.write_file).toBe(1);
    const session = after.session({ id: 'chat' });
    expect(roles(await session.load())).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(await session.pending()).toBeNull();
    expect(await store.checkpoints.load('chat.turn-0')).toBeNull();
  });

  it('streamResolve() from a fresh agent commits the session turn too', async () => {
    const runs: Runs = {};
    const tools = [tool('write_file', runs, { needsApproval: true })];
    const store = memoryStore();
    const before = createAgent({ provider: mockModel([calling('write_file')]), tools, store });
    const paused = await before.session({ id: 'chat' }).send('update a.txt');

    const after = createAgent({ provider: mockModel(['Wrote it.']), tools, store });
    const run = after.approvals.streamResolve({ id: paused.approvalId!, approved: true });
    const events: string[] = [];
    for await (const event of run) events.push(event.type);
    const result = await run.result;

    expect(result.text).toBe('Wrote it.');
    expect(events).toContain('run.start');
    expect(roles(await after.session({ id: 'chat' }).load())).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('a continuation that fails after approval leaves a resumable turn holding the executed tool result', async () => {
    // support-desk F4: the stale checkpoint was deleted before the continued
    // run, so a failure there erased the approved, already-executed call.
    const runs: Runs = {};
    const tools = [tool('refund', runs, { needsApproval: true })];
    const store = memoryStore();
    const agent = createAgent({
      provider: mockModel([calling('refund'), { error: new Error('Context size has been exceeded.') }, 'The $129 refund went through.']),
      tools,
      store,
    });
    const session = agent.session({ id: 'cust-1' });
    const paused = await session.send('refund my $129 order');
    await expect(agent.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toThrow('Context size has been exceeded');
    expect(runs.refund).toBe(1);

    // The turn is still pending (in-progress), with the tool result recorded.
    const checkpoint = await store.checkpoints.load('cust-1.turn-0');
    expect(checkpoint?.status).toBe('in-progress');
    expect(checkpoint?.messages.map((m) => m.role)).toContain('tool');

    const fresh = agent.session({ id: 'cust-1' });
    expect(await fresh.pending()).toMatchObject({ status: 'in-progress' });
    const done = await fresh.resume();
    expect(done?.text).toBe('The $129 refund went through.');
    expect(runs.refund).toBe(1); // the approved call did not run again
    expect(roles(await fresh.load())).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(await store.checkpoints.load('cust-1.turn-0')).toBeNull();
  });

  it('a finished turn keeps its checkpoint history, so the turn stays forkable', async () => {
    // incident-responder F2: commit() deleted the turn's checkpoint AND its
    // history, leaving nothing for agent.fork() - unlike a send({ sessionId })
    // run, which keeps a 'finished' checkpoint.
    const store = memoryStore();
    const agent = createAgent({ provider: mockModel(['first answer', 'fork answer']), store });
    await agent.session({ id: 'chat' }).send('hi');

    expect(await store.checkpoints.load('chat.turn-0')).toBeNull();
    const history = await store.checkpoints.history!('chat.turn-0');
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].status).toBe('finished');

    const forked = await agent.fork('chat.turn-0', { fromStep: history[0].step });
    const out = await agent.send('again?', { sessionId: forked.sessionId });
    expect(out.text).toBe('fork answer');
  });

  // Eve DUR-F8: clear() deleted only the current turn's checkpoint; every committed turn's checkpoint HISTORY (full
  // transcript copies) survived, and agent.fork('<id>.turn-<n>') revived the cleared conversation.
  it.each([
    ['memoryStore()', memoryStore],
    ["SqliteStore(':memory:')", () => new SqliteStore(':memory:')],
    ['KVCheckpointStore', () => {
      const data = new Map<string, string>();
      const kv = { get: async (key: string) => data.get(key) ?? null, put: async (key: string, value: string) => void data.set(key, value), delete: async (key: string) => void data.delete(key) };
      return { sessions: new MemorySessionStore(), checkpoints: new KVCheckpointStore(kv) };
    }],
  ])('clear() deletes every turn checkpoint and its history, so fork cannot revive the conversation (%s)', async (_name, makeStore) => {
    const store = makeStore();
    const runs: Runs = {};
    const model = mockModel([(r) => (r.messages.at(-1)?.role === 'tool' ? 'Noted.' : calling('lookup'))], { onExhausted: 'repeat-last' });
    const agent = createAgent({ provider: model, tools: [tool('lookup', runs)], store });
    const session = agent.session({ id: 'patient-9' });
    await session.send('hello');
    await session.send('My diagnosis is HIV-positive, please note it');
    await session.send('thanks');
    const turnIds = Array.from({ length: 13 }, (_, n) => `patient-9.turn-${n}`);
    const kept = async () => (await Promise.all(turnIds.map(async (id) => (await store.checkpoints.history!(id)).length))).reduce((a, b) => a + b, 0);
    expect(await kept()).toBeGreaterThan(0);

    await session.clear();

    expect(await agent.session({ id: 'patient-9' }).load()).toEqual([]);
    expect(await kept()).toBe(0);
    for (const id of turnIds) expect(await store.checkpoints.load(id)).toBeNull();
    await expect(agent.fork('patient-9.turn-4', { fromStep: 1 })).rejects.toThrow();
    // The session works again, from turn 0.
    expect((await session.send('hi again')).text).toBe('Noted.');
    (store as { close?: () => void }).close?.();
  });

  it('clear() also deletes the checkpoints of turns from before a compaction shortened the transcript (Eve DUR-F8)', async () => {
    const store = memoryStore();
    const runs: Runs = {};
    const model = mockModel([(r) => (r.messages.at(-1)?.role === 'tool' ? 'Noted.' : calling('lookup'))], { onExhausted: 'repeat-last' });
    const agent = createAgent({ provider: model, tools: [tool('lookup', runs)], store });
    const session = agent.session({ id: 'p' });
    for (const text of ['one', 'two', 'three']) await session.send(text);
    await session.compact({
      strategy: { name: 'summary', compact: async ({ messages }) => ({ messages: [{ role: 'user', content: 'summary' }, messages.at(-1)!], tokensBefore: 0, tokensAfter: 0, prunedToolCallIds: [] }) },
    });
    await session.send('four');
    const turnIds = Array.from({ length: 13 }, (_, n) => `p.turn-${n}`);
    const kept = async () => (await Promise.all(turnIds.map(async (id) => (await store.checkpoints.history!(id)).length))).reduce((a, b) => a + b, 0);
    expect((await store.checkpoints.history!('p.turn-8')).length).toBeGreaterThan(0);
    expect(session.messages).toHaveLength(6);

    await session.clear();

    expect(await kept()).toBe(0);
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
