/**
 * LOU-D30: createAgent({ store }) wires sessions, checkpoints and approvals
 * from one AgentStore (memoryStore() or a SqliteStore); agent.resume(id)
 * finishes an interrupted durable run or session turn.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from './createAgent';
import { defineTool, type DefinedTool } from './tools/defineTool';
import { PropagatingToolError } from './execution/AgentExecutor';
import { InMemoryApprovalStore } from './execution/InMemoryApprovalStore';
import { MemorySessionStore } from './session/sessionStore';
import { memoryStore, type AgentStore } from './storage/agentStore';
import { SqliteStore } from './storage/sqlite';
import { mockModel, type MockTurn } from './testing';

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

const calling = (name: string): MockTurn => ({ toolCalls: [{ name, id: `call_${name}` }] });
const roles = (messages: readonly { role: string }[]): string[] => messages.map((m) => m.role);

const stores: Array<[string, () => AgentStore & { close?: () => void }]> = [
  ['memoryStore()', memoryStore],
  ["SqliteStore(':memory:')", () => new SqliteStore(':memory:')],
];

describe.each(stores)('createAgent({ store: %s }) (LOU-D30)', (_name, makeStore) => {
  it('agent.session({ id }) keeps its transcript in store.sessions, across agents', async () => {
    const store = makeStore();
    await createAgent({ provider: mockModel(['Hi Ali.']), store }).session({ id: 'chat' }).send('My name is Ali.');

    const model = mockModel(['Ali.']);
    const { text } = await createAgent({ provider: model, store }).session({ id: 'chat' }).send('What is my name?');

    expect(text).toBe('Ali.');
    expect(model.calls[0].messages.some((m) => m.content === 'My name is Ali.')).toBe(true);
    expect(roles((await store.sessions!.load('chat'))!)).toEqual(['user', 'assistant', 'user', 'assistant']);
    store.close?.();
  });

  it('a crashed session turn is checkpointed in store.checkpoints and finished by agent.resume(id)', async () => {
    const store = makeStore();
    const runs: Runs = {};
    const tools = [tool('a', runs), tool('b', runs, { crashOnce: true })];
    const crashing = createAgent({ provider: mockModel([calling('a'), calling('b')]), tools, store });
    await expect(crashing.session({ id: 'chat' }).send('do a then b')).rejects.toThrow('process died');
    expect(await store.checkpoints!.load('chat.turn-0')).toMatchObject({ status: 'in-progress' });

    const model = mockModel(['All done.']);
    const agent = createAgent({ provider: model, tools, store });
    const result = await agent.resume('chat');

    expect(result?.text).toBe('All done.');
    expect(model.calls).toHaveLength(1);
    expect(runs).toEqual({ a: 1, b: 2 });
    expect(roles((await store.sessions!.load('chat'))!)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
    expect(await agent.resume('chat')).toBeNull();
    store.close?.();
  });

  it('send(message, { sessionId }) is a durable run: agent.resume(sessionId) finishes it after a crash', async () => {
    const store = makeStore();
    const runs: Runs = {};
    const tools = [tool('a', runs), tool('b', runs, { crashOnce: true })];
    const crashing = createAgent({ provider: mockModel([calling('a'), calling('b')]), tools, store });
    await expect(crashing.send('Run the job.', { sessionId: 'job-1' })).rejects.toThrow('process died');

    const model = mockModel(['Job finished.', 'It ran a and b.']);
    const agent = createAgent({ provider: model, tools, store });
    const result = await agent.resume('job-1');

    expect(result?.text).toBe('Job finished.');
    expect(model.calls).toHaveLength(1);
    expect(runs).toEqual({ a: 1, b: 2 });
    expect(await agent.resume('job-1')).toBeNull(); // finished: nothing pending
    expect(await agent.resume('never-ran')).toBeNull();

    // The same id continues the conversation.
    const next = await agent.send('What did you run?', { sessionId: 'job-1' });
    expect(next.text).toBe('It ran a and b.');
    expect(model.calls[1].messages.some((m) => m.content === 'Run the job.')).toBe(true);
    store.close?.();
  });

  it('pauses in store.approvals; agent.approvals.resolve() continues the durable run in a fresh agent', async () => {
    const store = makeStore();
    const runs: Runs = {};
    const tools = [tool('send_email', runs, { needsApproval: true })];
    const paused = await createAgent({ provider: mockModel([calling('send_email')]), tools, store }).send('Email Sam', {
      sessionId: 'job-2',
    });
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(await store.checkpoints!.load('job-2')).toMatchObject({ status: 'awaiting-approval' });

    const agent = createAgent({ provider: mockModel(['Email sent.']), tools, store });
    await expect(agent.resume('job-2')).rejects.toMatchObject({ name: 'SessionAwaitingApprovalError' });
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(result.text).toBe('Email sent.');
    expect(runs.send_email).toBe(1);
    expect(await store.checkpoints!.load('job-2')).toMatchObject({ status: 'finished' });
    expect(await agent.resume('job-2')).toBeNull();
    store.close?.();
  });
});

describe('createAgent({ store }) defaults and precedence (LOU-D30)', () => {
  it('explicit session store, checkpointStore and approvalStore win over the agent store', async () => {
    const store = memoryStore();
    const sessions = new MemorySessionStore();
    const checkpoints = memoryStore().checkpoints;
    const approvalStore = new InMemoryApprovalStore();
    const runs: Runs = {};
    const tools = [tool('send_email', runs, { needsApproval: true })];
    const agent = createAgent({ provider: mockModel([calling('send_email'), 'Hi.']), tools, store, approvalStore });

    const paused = await agent.session({ id: 'chat', store: sessions, checkpointStore: checkpoints }).send('Email Sam');

    expect(paused.finishReason).toBe('awaiting-approval');
    expect(await approvalStore.resolve(paused.approvalId!)).not.toBeNull();
    expect(await store.approvals.resolve(paused.approvalId!)).toBeNull();
    expect(await checkpoints.load('chat.turn-0')).toMatchObject({ status: 'awaiting-approval' });
    expect(await store.checkpoints.load('chat.turn-0')).toBeNull();

    // A plain SessionStore replaces store.sessions only; checkpoints still come from the agent store.
    await agent.session({ id: 'other', store: sessions }).send('hello');
    expect(roles((await sessions.load('other'))!)).toEqual(['user', 'assistant']);
    expect(await store.sessions.load('other')).toBeUndefined();
  });

  it('send({ sessionId }) without a checkpoint store throws, and plain runs are not checkpointed', async () => {
    const sessions = new MemorySessionStore();
    const agent = createAgent({ provider: mockModel(['Hi.']), store: { sessions } });

    await expect(agent.send('hi', { sessionId: 'job-1' })).rejects.toThrow(/needs a checkpoint store/);
    expect(() => agent.stream('hi', { sessionId: 'job-1' })).toThrow(/needs a checkpoint store/);
    await expect(agent.send('hi', { sessionId: 'job-1' })).rejects.toMatchObject({
      code: 'LOUSHO_CONFIG_MISSING_CHECKPOINT_STORE',
    });
    expect(await agent.resume('job-1')).toBeNull();

    const store = memoryStore();
    await createAgent({ provider: mockModel(['Hi.']), store }).send('hi');
    expect(await store.checkpoints.load('job-1')).toBeNull();
  });

  // Eve DUR-F2: concurrent send({ sessionId }) calls on one id read the same 'finished' checkpoint and the last save dropped the other turn.
  it.each(stores)('concurrent send()/stream() with one sessionId run one after another, keeping every turn (%s)', async (_name, makeStore) => {
    const store = makeStore();
    const echo: MockTurn = (request) => ({ text: `ack ${String(request.messages.at(-1)?.content)}`, delayMs: 20 });
    const agent = createAgent({ provider: mockModel([echo], { onExhausted: 'repeat-last' }), store });
    await agent.send('first', { sessionId: 'chat-42' });

    const streamed = agent.stream('order ramen', { sessionId: 'chat-42' });
    const results = await Promise.all([
      agent.send('order pizza', { sessionId: 'chat-42' }),
      agent.send('order sushi', { sessionId: 'chat-42' }),
      streamed.result,
    ]);

    expect(results.map((r) => r.finishReason)).toEqual(['stop', 'stop', 'stop']);
    const users = (await store.checkpoints!.load('chat-42'))!.messages.filter((m) => m.role === 'user').map((m) => m.content);
    expect(users[0]).toBe('first');
    expect(users.slice(1).sort()).toEqual(['order pizza', 'order ramen', 'order sushi']);
    store.close?.();
  });
});
