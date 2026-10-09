/**
 * Eve TOOLS-F12: a model step with several calls that need approval pauses
 * once, on all of them (`approvalIds`); they can be decided in any order, and
 * the step's approved calls run only once every one of them is decided.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgent } from './createAgent';
import { defineTool } from './tools/defineTool';
import { mockModel } from './testing';
import type { Message } from './providers';
import { fileStore } from './storage/fileStore';
import { memoryStore, type AgentStore } from './storage/agentStore';
import { SqliteStore } from './storage/sqlite';
import type { AgentEvent } from './execution/agentEvents';

function tools(log: string[]) {
  const make = (name: string, needsApproval: boolean) =>
    defineTool({
      name,
      description: name,
      input: z.object({ n: z.number() }),
      needsApproval,
      execute: async ({ n }) => {
        log.push(`${name}(${n})`);
        return `${name} ok`;
      },
    });
  return [make('wire_money', true), make('delete_db', true), make('read_status', false)];
}

const twoApprovals = {
  toolCalls: [
    { name: 'wire_money', args: { n: 1 }, id: 'call_wire' },
    { name: 'delete_db', args: { n: 2 }, id: 'call_delete' },
  ],
};

const toolMessages = (messages: readonly Message[]) => messages.filter((m) => m.role === 'tool');

describe('Eve TOOLS-F12: parallel approvals', () => {
  it('pauses once with every pending call; nothing runs until the last one is decided', async () => {
    const log: string[] = [];
    const model = mockModel([twoApprovals, 'done']);
    const agent = createAgent({ provider: model, tools: tools(log) });

    const paused = await agent.send('go');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.approvalIds).toHaveLength(2);
    expect(paused.approvalId).toBe(paused.approvalIds![0]);
    const listed = await agent.approvals.list();
    expect(listed.map((p) => p.toolName)).toEqual(['wire_money', 'delete_db']);
    expect(listed.map((p) => p.id)).toEqual(paused.approvalIds);

    const [wire, del] = paused.approvalIds!;
    // Decided out of order: the second call first.
    const partial = await agent.approvals.resolve({ id: del, approved: true });
    expect(partial.finishReason).toBe('awaiting-approval');
    expect(partial.approvalIds).toEqual([wire]);
    expect(partial.approvalId).toBe(wire);
    expect(log).toEqual([]);
    expect(model.calls).toHaveLength(1);
    expect((await agent.approvals.list()).map((p) => p.id)).toEqual([wire]);

    const result = await agent.approvals.resolve({ id: wire, approved: true });
    expect(result.text).toBe('done');
    expect(log).toEqual(['wire_money(1)', 'delete_db(2)']);
    expect(toolMessages(result.messages).map((m) => m.toolCallId)).toEqual(['call_wire', 'call_delete']);
    expect(model.calls).toHaveLength(2);
    expect(await agent.approvals.list()).toEqual([]);
  });

  it('a denied call gets its rejection, the approved one runs; the same id cannot be decided twice', async () => {
    const log: string[] = [];
    const agent = createAgent({ provider: mockModel([twoApprovals, 'done']), tools: tools(log) });
    const paused = await agent.send('go');
    const [wire, del] = paused.approvalIds!;

    await agent.approvals.resolve({ id: wire, approved: false, note: 'too much' });
    await expect(agent.approvals.resolve({ id: wire, approved: true })).rejects.toMatchObject({ code: 'LOUSHO_APPROVAL_NOT_FOUND' });
    const result = await agent.approvals.resolve({ id: del, approved: true });

    expect(log).toEqual(['delete_db(2)']);
    const [rejected, ran] = toolMessages(result.messages);
    expect(rejected).toMatchObject({ toolCallId: 'call_wire', isError: true });
    expect(JSON.parse(String(rejected.content))).toMatchObject({ kind: 'rejected', note: 'too much' });
    expect(ran).toMatchObject({ toolCallId: 'call_delete', content: JSON.stringify('delete_db ok') });
  });

  it('resolveAll() decides the whole step at once, with edited arguments', async () => {
    const log: string[] = [];
    const agent = createAgent({ provider: mockModel([twoApprovals, 'done']), tools: tools(log) });
    const paused = await agent.send('go');
    const [wire, del] = paused.approvalIds!;

    const result = await agent.approvals.resolveAll([
      { id: wire, approved: true, args: { n: 10 } },
      { id: del, approved: true },
    ]);

    expect(result.text).toBe('done');
    expect(log).toEqual(['wire_money(10)', 'delete_db(2)']);
    const call = result.messages.find((m) => m.role === 'assistant' && m.toolCalls)?.toolCalls?.find((c) => c.id === 'call_wire');
    expect(JSON.parse(call!.function.arguments)).toEqual({ n: 10 });
    await expect(agent.approvals.resolveAll([])).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
  });

  it('invalid edited arguments leave the call pending', async () => {
    const log: string[] = [];
    const agent = createAgent({ provider: mockModel([twoApprovals, 'done']), tools: tools(log) });
    const paused = await agent.send('go');
    const [wire] = paused.approvalIds!;

    await expect(agent.approvals.resolve({ id: wire, approved: true, args: { n: 'x' } })).rejects.toMatchObject({ code: 'LOUSHO_TOOL_ARGS_INVALID' });
    expect((await agent.approvals.list()).map((p) => p.id)).toEqual(paused.approvalIds);
  });

  it('the calls of the step that need no approval run at once', async () => {
    const log: string[] = [];
    const step = {
      toolCalls: [
        { name: 'read_status', args: { n: 0 }, id: 'call_a' },
        { name: 'wire_money', args: { n: 1 }, id: 'call_wire' },
        { name: 'read_status', args: { n: 3 }, id: 'call_c' },
        { name: 'delete_db', args: { n: 2 }, id: 'call_delete' },
      ],
    };
    const agent = createAgent({ provider: mockModel([step, 'done']), tools: tools(log) });
    const paused = await agent.send('go');
    expect(paused.approvalIds).toHaveLength(2);
    expect(log).toEqual(['read_status(0)', 'read_status(3)']);

    const result = await agent.approvals.resolveAll(paused.approvalIds!.map((id) => ({ id, approved: true })));
    expect(log).toEqual(['read_status(0)', 'read_status(3)', 'wire_money(1)', 'delete_db(2)']);
    expect(toolMessages(result.messages).map((m) => m.toolCallId)).toEqual(['call_a', 'call_wire', 'call_c', 'call_delete']);
  });

  it('one call that needs approval keeps the single-approval shape', async () => {
    const log: string[] = [];
    const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'wire_money', args: { n: 1 } }] }, 'done']), tools: tools(log) });
    const paused = await agent.send('go');
    expect(paused.approvalIds).toEqual([paused.approvalId]);
    expect((await agent.approvals.resolve({ id: paused.approvalId!, approved: true })).text).toBe('done');
  });

  it('an approve callback is asked about each call; a deferred one is left to a human', async () => {
    const log: string[] = [];
    const asked: string[] = [];
    const agent = createAgent({
      provider: mockModel([twoApprovals, 'done']),
      tools: tools(log),
      approve: ({ toolName }) => {
        asked.push(toolName);
        return toolName === 'wire_money' ? 'defer' : true;
      },
    });
    const paused = await agent.send('go');
    expect(asked).toEqual(['wire_money', 'delete_db']);
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.approvalIds).toHaveLength(1);
    expect(log).toEqual([]);

    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(result.text).toBe('done');
    expect(asked).toEqual(['wire_money', 'delete_db']);
    expect(log).toEqual(['wire_money(1)', 'delete_db(2)']);
  });

  it('streams one approval.requested per call, and the continuation reports both calls', async () => {
    const log: string[] = [];
    const agent = createAgent({ provider: mockModel([twoApprovals, 'done']), tools: tools(log) });
    const run = agent.stream('go');
    const requested: string[] = [];
    for await (const event of run) if (event.type === 'approval.requested') requested.push(event.approvalId);
    const paused = await run.result;
    expect(requested).toEqual(paused.approvalIds);

    const first = agent.approvals.streamResolve({ id: requested[0], approved: true });
    for await (const event of first) void event;
    expect((await first.result).approvalIds).toEqual([requested[1]]);

    const events: AgentEvent[] = [];
    const last = agent.approvals.streamResolve({ id: requested[1], approved: true });
    for await (const event of last) events.push(event);
    expect((await last.result).text).toBe('done');
    expect(events.filter((e) => e.type === 'tool.resume').map((e) => (e as { toolCallId: string }).toolCallId)).toEqual(['call_wire', 'call_delete']);
  });

  it('a session turn continues in its session, whichever call is decided last', async () => {
    const log: string[] = [];
    const agent = createAgent({ provider: mockModel([twoApprovals, 'done', 'second turn']), tools: tools(log), store: memoryStore() });
    const session = agent.session({ id: 's1' });
    const paused = await session.send('go');
    const pending = await session.pending();
    expect(pending).toMatchObject({ status: 'awaiting-approval', approvalId: paused.approvalIds![0], approvalIds: paused.approvalIds });

    await agent.approvals.resolve({ id: paused.approvalIds![0], approved: true });
    expect(await session.pending()).toMatchObject({ status: 'awaiting-approval', approvalId: paused.approvalIds![1] });
    await expect(session.send('more')).rejects.toMatchObject({ code: 'LOUSHO_SESSION_AWAITING_APPROVAL' });

    const result = await agent.approvals.resolve({ id: paused.approvalIds![1], approved: true });
    expect(result.text).toBe('done');
    expect(await session.pending()).toBeNull();
    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
    expect((await session.send('more')).text).toBe('second turn');
  });

  it("pauses the lead once on a sub-agent's parallel approvals", async () => {
    const log: string[] = [];
    const worker = createAgent({ provider: mockModel([twoApprovals, 'worker done']), tools: tools(log), description: 'Does risky things' });
    const task = { name: 'task', args: { agent: 'worker', prompt: 'do it', description: 'risky' } };
    const lead = createAgent({ provider: mockModel([{ toolCalls: [task] }, 'lead done']), subagents: { worker } });

    const paused = await lead.send('go');
    expect(paused.approvalIds).toHaveLength(2);
    const listed = await lead.approvals.list();
    expect(listed).toEqual([
      expect.objectContaining({ toolName: 'wire_money', subagentPath: ['worker'] }),
      expect.objectContaining({ toolName: 'delete_db', subagentPath: ['worker'] }),
    ]);

    const partial = await lead.approvals.resolve({ id: paused.approvalIds![1], approved: false });
    expect(partial.approvalIds).toEqual([paused.approvalIds![0]]);
    expect(log).toEqual([]);
    const result = await lead.approvals.resolve({ id: paused.approvalIds![0], approved: true });
    expect(result.text).toBe('lead done');
    expect(log).toEqual(['wire_money(1)']);
  });
});

describe('Eve TOOLS-F12: parallel approvals with durable stores', () => {
  const dirs: string[] = [];
  const opened: Array<{ close(): void }> = [];
  afterEach(() => {
    while (opened.length) opened.pop()?.close();
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-parallel-appr-'));
    dirs.push(dir);
    return dir;
  };
  const kinds: Array<[string, () => () => AgentStore]> = [
    ['fileStore', () => {
      const dir = tempDir();
      return () => fileStore(dir);
    }],
    ['SqliteStore', () => {
      const path = join(tempDir(), 'agent.db');
      return () => {
        const store = new SqliteStore(path);
        opened.push(store);
        return store;
      };
    }],
  ];

  for (const [name, setup] of kinds) {
    it(`${name}: each call is decided by a different process; the last one runs the step in its session`, async () => {
      const mkStore = setup();
      const log: string[] = [];
      const a = createAgent({ provider: mockModel([twoApprovals]), tools: tools(log), store: mkStore() });
      const paused = await a.session({ id: 'durable' }).send('go');
      const [wire, del] = paused.approvalIds!;

      const b = createAgent({ provider: mockModel([]), tools: tools(log), store: mkStore() }); // "restart"
      expect((await b.approvals.list()).map((p) => p.id)).toEqual([wire, del]);
      const partial = await b.approvals.resolve({ id: wire, approved: true });
      expect(partial.approvalIds).toEqual([del]);
      expect(log).toEqual([]);

      const c = createAgent({ provider: mockModel(['done']), tools: tools(log), store: mkStore() }); // another restart
      expect((await c.approvals.list()).map((p) => p.id)).toEqual([del]);
      expect(await c.session({ id: 'durable' }).pending()).toMatchObject({ status: 'awaiting-approval', approvalId: del });
      const result = await c.approvals.resolve({ id: del, approved: true });
      expect(result.text).toBe('done');
      expect(log).toEqual(['wire_money(1)', 'delete_db(2)']);
      const session = c.session({ id: 'durable' });
      await session.load();
      expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
    });
  }
});
