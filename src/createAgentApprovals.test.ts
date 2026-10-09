/**
 * LOU-D21: createAgent() agents pause for approval (in-memory store by
 * default) and resume with `agent.approvals.resolve()` or an `approve` callback.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgent } from './createAgent';
import { defineTool } from './tools/defineTool';
import { InMemoryApprovalStore } from './execution/InMemoryApprovalStore';
import { mockModel } from './testing';
import type { Message } from './providers';
import { fileStore } from './storage/fileStore';
import { memoryStore, type AgentStore } from './storage/agentStore';
import { SqliteStore } from './storage/sqlite';

function emailTool() {
  const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
  const tool = defineTool({
    name: 'send_email',
    description: 'Sends an email',
    input: z.object({ to: z.string() }),
    needsApproval: true,
    execute,
  });
  return { tool, execute };
}

const callEmail = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_email' }] };

function toolResult(messages: readonly Message[]): Message | undefined {
  return messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_email');
}

describe('createAgent approvals (LOU-D21)', () => {
  it('pauses on a needsApproval tool, then approving runs the tool and finishes', async () => {
    const { tool, execute } = emailTool();
    const agent = createAgent({ provider: mockModel([callEmail, 'Email sent.']), tools: [tool] });

    const paused = await agent.send('Email Sam');

    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.approvalId).toBeDefined();
    expect(execute).not.toHaveBeenCalled();
    const [pending] = await agent.approvals.list();
    expect(pending).toMatchObject({ id: paused.approvalId, toolName: 'send_email', args: { to: 'sam@example.com' } });

    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('Email sent.');
    expect(toolResult(result.messages)?.content).toBe(JSON.stringify('sent to sam@example.com'));
    expect(await agent.approvals.list()).toEqual([]);
    await expect(agent.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toThrow(/No pending approval/);
  });

  it('rejecting gives the model a structured rejection and does not run the tool', async () => {
    const { tool, execute } = emailTool();
    const model = mockModel([callEmail, 'OK, I will not send it.']);
    const agent = createAgent({ provider: model, tools: [tool] });

    const paused = await agent.send('Email Sam');
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: false, note: 'Not today' });

    expect(execute).not.toHaveBeenCalled();
    expect(result.text).toBe('OK, I will not send it.');
    const rejection = toolResult(model.calls[1].messages as Message[]);
    expect(rejection?.isError).toBe(true);
    expect(JSON.parse(rejection?.content as string)).toEqual({
      error: 'ToolRejectedError',
      toolName: 'send_email',
      message: 'Tool execution was rejected by the reviewer',
      kind: 'rejected',
      note: 'Not today',
    });
  });

  it('an approve callback decides at once, without pausing', async () => {
    const approved = emailTool();
    const approve = vi.fn(() => true);
    const yes = createAgent({ provider: mockModel([callEmail, 'Sent.']), tools: [approved.tool], approve });

    const result = await yes.send('Email Sam');

    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('Sent.');
    expect(approved.execute).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'send_email', toolCallId: 'call_email', args: { to: 'sam@example.com' } })
    );

    const denied = emailTool();
    const no = createAgent({ provider: mockModel([callEmail, 'Not sent.']), tools: [denied.tool], approve: async () => false });

    const rejected = await no.send('Email Sam');

    expect(rejected.finishReason).toBe('stop');
    expect(denied.execute).not.toHaveBeenCalled();
    expect(toolResult(rejected.messages)?.isError).toBe(true);
    expect(await no.approvals.list()).toEqual([]);
  });

  it("'defer' leaves the pause undecided - listed, and resolvable by a human afterwards", async () => {
    const { tool, execute } = emailTool();
    const approve = vi.fn(() => 'defer' as const);
    const agent = createAgent({ provider: mockModel([callEmail, 'Sent.']), tools: [tool], approve });

    const paused = await agent.send('Email Sam');

    // The send() surfaces the pause, not a verdict: the callback was asked but chose not to decide.
    expect(approve).toHaveBeenCalledTimes(1);
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(execute).not.toHaveBeenCalled();
    const [pending] = await agent.approvals.list();
    expect(pending).toMatchObject({ id: paused.approvalId, toolName: 'send_email' });

    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('Sent.');
    expect(await agent.approvals.list()).toEqual([]);
  });

  it("decides the calls it can and defers the rest: a 'defer' after resolve() surfaces the next pause", async () => {
    const { tool, execute } = emailTool();
    const lookup = defineTool({
      name: 'lookup',
      description: 'Reads a record',
      input: z.object({ id: z.string() }),
      needsApproval: true,
      execute: async ({ id }: { id: string }) => `record ${id}`,
    });
    const callLookup = { toolCalls: [{ name: 'lookup', args: { id: 't-1' }, id: 'call_lookup' }] };
    const approve = vi.fn(({ toolName }: { toolName: string }) => (toolName === 'lookup' ? true : 'defer'));
    const agent = createAgent({ provider: mockModel([callLookup, callEmail, 'Done.']), tools: [lookup, tool], approve });

    const paused = await agent.send('Look up the ticket, then email Sam');

    // `lookup` was auto-approved and ran; `send_email` was deferred: the run surfaces that pause.
    expect(paused.finishReason).toBe('awaiting-approval');
    const [pending] = await agent.approvals.list();
    expect(pending).toMatchObject({ toolName: 'send_email' });

    const result = await agent.approvals.resolve({ id: pending.id, approved: true });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('Done.');
    expect(await agent.approvals.list()).toEqual([]);
  });

  it("'defer' on a session turn keeps the pause bound to that session", async () => {
    const { tool, execute } = emailTool();
    const agent = createAgent({ provider: mockModel([callEmail, 'Sent.']), tools: [tool], approve: () => 'defer' });
    const session = agent.session();

    const paused = await session.send('Email Sam');

    expect(paused.finishReason).toBe('awaiting-approval');
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(result.text).toBe('Sent.');
    expect(execute).toHaveBeenCalledTimes(1);
    // The continued turn was committed to the session it paused in.
    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('gives each agent its own default store', async () => {
    const first = createAgent({ provider: mockModel([callEmail]), tools: [emailTool().tool] });
    const second = createAgent({ provider: mockModel([callEmail]), tools: [emailTool().tool] });

    const paused = await first.send('Email Sam');

    expect(await second.approvals.list()).toEqual([]);
    await expect(second.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toThrow(/No pending approval/);
    expect(await first.approvals.list()).toHaveLength(1);
  });

  it('uses the approvalStore option when given', async () => {
    const approvalStore = new InMemoryApprovalStore();
    const save = vi.spyOn(approvalStore, 'save');
    const agent = createAgent({ provider: mockModel([callEmail, 'Done.']), tools: [emailTool().tool], approvalStore });

    const paused = await agent.send('Email Sam');

    expect(save).toHaveBeenCalledTimes(1);
    expect(await approvalStore.resolve(paused.approvalId!)).toMatchObject({ pending: { toolName: 'send_email' } });
  });

  it('get() returns a pause this process did not make, through a shared approvalStore, without resolving it (#280)', async () => {
    const approvalStore = new InMemoryApprovalStore();
    const { tool, execute } = emailTool();
    const first = createAgent({ provider: mockModel([callEmail, 'Email sent.']), tools: [tool], approvalStore });
    const paused = await first.send('Email Sam');

    // "after a restart": another agent over the same store lists the pause (Eve TOOLS-F13), and get() finds it
    const second = createAgent({ provider: mockModel(['unused']), tools: [emailTool().tool], approvalStore });
    expect((await second.approvals.list()).map((entry) => entry.id)).toEqual([paused.approvalId]);
    expect(await second.approvals.get(paused.approvalId!)).toMatchObject({ id: paused.approvalId, toolName: 'send_email', args: { to: 'sam@example.com' } });
    expect(await second.approvals.get('nope')).toBeUndefined();

    // the read did not resolve it: either agent can still decide it
    const result = await first.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(result.text).toBe('Email sent.');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await second.approvals.get(paused.approvalId!)).toBeUndefined();
  });

  it('resolving a pause from a session continues that session', async () => {
    const { tool } = emailTool();
    const model = mockModel([callEmail, 'Email sent.', 'You asked me to email Sam.']);
    const agent = createAgent({ provider: model, tools: [tool] });
    const session = agent.session();

    const paused = await session.send('Email Sam');
    expect(paused.finishReason).toBe('awaiting-approval');
    await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const followUp = await session.send('What did I ask?');
    expect(followUp.text).toBe('You asked me to email Sam.');
    const sent = model.calls[2].messages.map((m) => m.content);
    expect(sent).toContain('Email Sam');
    expect(sent).toContain('Email sent.');
    expect(sent).toContain(JSON.stringify('sent to sam@example.com'));
  });

  it("pauses on a sub-agent's tool and resumes it through the lead's approvals", async () => {
    const { tool, execute } = emailTool();
    const mailer = createAgent({ provider: mockModel([callEmail, 'Mailed.']), tools: [tool], description: 'Sends mail' });
    const task = { name: 'task', args: { agent: 'mailer', prompt: 'Email Sam', description: 'mail' } };
    const lead = createAgent({ provider: mockModel([{ toolCalls: [task] }, 'All done.']), subagents: { mailer } });

    const paused = await lead.send('Email Sam via the mailer');
    const [pending] = await lead.approvals.list();
    expect(pending).toMatchObject({ toolName: 'send_email', subagentPath: ['mailer'] });

    const result = await lead.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('All done.');
  });

  it('stream() ends at the pause instead of throwing', async () => {
    const agent = createAgent({ provider: mockModel([callEmail, 'Sent.']), tools: [emailTool().tool] });

    const run = agent.stream('Email Sam');
    for await (const event of run) void event;
    const paused = await run.result;

    expect(paused.finishReason).toBe('awaiting-approval');
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(result.text).toBe('Sent.');
  });
});

describe('createAgent approvals: expiry (TTL)', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('stamps expiresAt on the pause, list() and the approval.requested event', async () => {
    const events: string[] = [];
    const seen = vi.fn();
    const agent = createAgent({
      provider: mockModel([callEmail]),
      tools: [emailTool().tool],
      approvalTtlMs: 60_000,
      onEvent: (event) => {
        events.push(event.type);
        if (event.type === 'approval.requested') seen(event);
      },
    });

    const paused = await agent.send('Email Sam');

    const [pending] = await agent.approvals.list();
    expect(pending?.expiresAt).toBeDefined();
    expect(Date.parse(pending!.expiresAt!) - Date.now()).toBeGreaterThan(0);
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.requested', expiresAt: pending!.expiresAt }));
    expect(paused.finishReason).toBe('awaiting-approval');
  });

  it('denies a resolve() that arrives after expiresAt - even approved: true', async () => {
    const { tool, execute } = emailTool();
    const model = mockModel([callEmail, 'Too late then.']);
    const agent = createAgent({ provider: model, tools: [tool], approvalTtlMs: 40 });

    const paused = await agent.send('Email Sam');
    await sleep(60);
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(execute).not.toHaveBeenCalled();
    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('Too late then.');
    const denial = toolResult(model.calls[1].messages as Message[]);
    expect(JSON.parse(denial?.content as string)).toMatchObject({ kind: 'denied', message: expect.stringContaining('expired') });
  });

  it('an approve callback still waiting at the deadline loses to it', async () => {
    const { tool, execute } = emailTool();
    const approve = vi.fn(() => new Promise<boolean>(() => {})); // a UI that never answers
    const agent = createAgent({ provider: mockModel([callEmail, 'Understood.']), tools: [tool], approve, approvalTtlMs: 40 });

    const result = await agent.send('Email Sam');

    expect(approve).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('Understood.');
    expect(await agent.approvals.list()).toEqual([]);
  });

  it('an approve callback answering before the deadline still decides', async () => {
    const { tool, execute } = emailTool();
    const agent = createAgent({ provider: mockModel([callEmail, 'Sent.']), tools: [tool], approve: () => true, approvalTtlMs: 60_000 });

    const result = await agent.send('Email Sam');

    expect(result.text).toBe('Sent.');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("send()'s approvalTtlMs overrides the agent's for that run", async () => {
    const agent = createAgent({ provider: mockModel([callEmail]), tools: [emailTool().tool] });

    const paused = await agent.send('Email Sam', { approvalTtlMs: 60_000 });

    const [pending] = await agent.approvals.list();
    expect(pending?.id).toBe(paused.approvalId);
    expect(pending?.expiresAt).toBeDefined();
  });

  it("a sub-agent's pause inherits the lead's approvalTtlMs", async () => {
    const { tool } = emailTool();
    const mailer = createAgent({ provider: mockModel([callEmail, 'Mailed.']), tools: [tool], description: 'Sends mail' });
    const task = { name: 'task', args: { agent: 'mailer', prompt: 'Email Sam', description: 'mail' } };
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [task] }, 'All done.']),
      subagents: { mailer },
      approvalTtlMs: 60_000,
    });

    const paused = await lead.send('Email Sam via the mailer');

    const [pending] = await lead.approvals.list();
    expect(pending).toMatchObject({ toolName: 'send_email', subagentPath: ['mailer'] });
    expect(pending?.expiresAt).toBeDefined();
    expect(paused.finishReason).toBe('awaiting-approval');
  });

  it('rejects a non-positive approvalTtlMs at createAgent()', () => {
    expect(() => createAgent({ provider: mockModel(['x']), approvalTtlMs: 0 })).toThrow(/approvalTtlMs/);
    expect(() => createAgent({ provider: mockModel(['x']), approvalTtlMs: Number.NaN })).toThrow(/approvalTtlMs/);
  });
});

describe('createAgent approvals: durable list and cross-process staleness (Eve TOOLS-F13, DUI-F15)', () => {
  const dirs: string[] = [];
  const opened: Array<{ close(): void }> = [];
  afterEach(() => {
    while (opened.length) opened.pop()?.close();
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-appr-list-'));
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
          opened.push(store);
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

  for (const [name, setup] of kinds) {
    it(`${name}: list() after a restart shows the stored pause; get()/list() drop it once another agent resolves it`, async () => {
      const mkStore = setup();
      const { tool, execute } = emailTool();
      const a = createAgent({ provider: mockModel([callEmail, 'done A']), tools: [tool], store: mkStore() });
      const paused = await a.send('Email Sam');
      expect(await a.approvals.list()).toHaveLength(1);

      const b = createAgent({ provider: mockModel(['done B']), tools: [tool], store: mkStore() }); // "restart"
      const listed = await b.approvals.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: paused.approvalId, toolName: 'send_email', args: { to: 'sam@example.com' } });

      const result = await b.approvals.resolve({ id: paused.approvalId!, approved: true });
      expect(result.text).toBe('done B');
      expect(execute).toHaveBeenCalledTimes(1);

      // A still remembered the pause in memory: it must not report it any more.
      expect(await a.approvals.get(paused.approvalId!)).toBeUndefined();
      expect(await a.approvals.list()).toEqual([]);
      expect(await b.approvals.list()).toEqual([]);
    });
  }

  it("merges this process's pauses with the stored ones, oldest first, without duplicates", async () => {
    const dir = tempDir();
    const { tool } = emailTool();
    const a = createAgent({ provider: mockModel([callEmail]), tools: [tool], store: fileStore(dir) });
    const first = await a.send('one');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const callKim = { toolCalls: [{ name: 'send_email', args: { to: 'kim@example.com' }, id: 'call_2' }] };
    const b = createAgent({ provider: mockModel([callKim]), tools: [tool], store: fileStore(dir) });
    const second = await b.send('two');
    const ids = (await b.approvals.list()).map((entry) => entry.id);
    expect(ids).toEqual([first.approvalId, second.approvalId]);
    expect((await a.approvals.list()).map((entry) => entry.id)).toEqual(ids);
  });

  it("a store without list() or load() still lists and gets this process's pauses", async () => {
    const inner = new InMemoryApprovalStore();
    const approvalStore = { save: inner.save.bind(inner), resolve: inner.resolve.bind(inner) };
    const { tool } = emailTool();
    const agent = createAgent({ provider: mockModel([callEmail]), tools: [tool], approvalStore });
    const paused = await agent.send('Email Sam');
    expect((await agent.approvals.list()).map((entry) => entry.id)).toEqual([paused.approvalId]);
    expect((await agent.approvals.get(paused.approvalId!))?.id).toBe(paused.approvalId);
  });
});
