/**
 * N4: permission modes - `plan`, `acceptEdits` and `dontAsk` as presets over
 * the permission rules and `needsApproval`, applied after them in the gate.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { createFsTools } from '../tools/workspace/fsTools';
import { MemoryWorkspace } from '../tools/workspace/MemoryWorkspace';
import { remoteAgent } from '../subagents/remoteAgent';
import { mockModel, type MockModel } from '../testing';
import type { AgentEvent, AgentEventOf } from './agentEvents';
import {
  allow,
  deny,
  DONT_ASK_REASON,
  PLAN_MODE_INSTRUCTION,
  PLAN_MODE_REASON,
  type PermissionDecisionEntry,
  type PermissionMode,
  type PermissionModeChange,
} from './permissions';

/** A tool that records its calls. */
function tool(name: string, options: { needsApproval?: boolean; readOnly?: boolean; editsFiles?: boolean } = {}) {
  const calls: unknown[] = [];
  const defined = defineTool({
    name,
    description: `The ${name} tool`,
    input: z.object({ value: z.string().optional() }),
    needsApproval: options.needsApproval,
    editsFiles: options.editsFiles,
    ...(options.readOnly && { annotations: { readOnlyHint: true } }),
    execute: async () => {
      calls.push(name);
      return `${name} ran`;
    },
  });
  return { defined, calls };
}

/** One of each kind of tool the mode table distinguishes. */
function toolbox() {
  return {
    peek: tool('peek', { readOnly: true }),
    patch: tool('patch', { needsApproval: true, editsFiles: true }),
    deploy: tool('deploy', { needsApproval: true }),
    ping: tool('ping'),
    notify: tool('notify', { needsApproval: true }),
    rm: tool('rm'),
  };
}

const RULES = [allow('notify'), deny('rm', 'No deletes')];

type Outcome = 'ran' | 'paused' | 'denied by rule' | 'denied by plan' | 'denied by dontAsk';

/** The first tool result the model saw, parsed (undefined when the run paused before the second call). */
function firstToolResult(model: MockModel): Record<string, unknown> | undefined {
  const message = model.calls[1]?.messages.find((m) => m.role === 'tool');
  return message && (JSON.parse(String(message.content)) as Record<string, unknown>);
}

/** Runs one call of `toolName` under `mode` and says what became of it. */
async function outcomeOf(mode: PermissionMode, toolName: string): Promise<{ outcome: Outcome; entries: PermissionDecisionEntry[] }> {
  const tools = toolbox();
  const entries: PermissionDecisionEntry[] = [];
  const args = toolName === 'ask_question' ? { question: 'Which file?' } : {};
  const model = mockModel([{ toolCalls: [{ name: toolName, id: 'c1', args }] }, 'done']);
  const agent = createAgent({
    provider: model,
    tools: Object.values(tools).map((t) => t.defined),
    askQuestion: true,
    permissions: RULES,
    permissionMode: mode,
    onPermissionDecision: (entry) => entries.push(entry),
  });
  const result = await agent.send('go');
  if (result.finishReason === 'awaiting-approval') return { outcome: 'paused', entries };
  const ran = Object.values(tools).some((t) => t.calls.length > 0);
  if (ran) return { outcome: 'ran', entries };
  const toolResult = firstToolResult(model);
  expect(toolResult).toMatchObject({ kind: 'denied' });
  const reason = toolResult?.reason;
  const outcome: Outcome = reason === PLAN_MODE_REASON ? 'denied by plan' : reason === DONT_ASK_REASON ? 'denied by dontAsk' : 'denied by rule';
  return { outcome, entries };
}

const TABLE: Record<PermissionMode, Record<string, Outcome>> = {
  default: {
    peek: 'ran',
    patch: 'paused',
    deploy: 'paused',
    ping: 'ran',
    notify: 'ran',
    rm: 'denied by rule',
    ask_question: 'paused',
  },
  plan: {
    peek: 'ran',
    patch: 'denied by plan',
    deploy: 'denied by plan',
    ping: 'denied by plan',
    notify: 'denied by plan',
    rm: 'denied by rule',
    ask_question: 'paused',
  },
  acceptEdits: {
    peek: 'ran',
    patch: 'ran',
    deploy: 'paused',
    ping: 'ran',
    notify: 'ran',
    rm: 'denied by rule',
    ask_question: 'paused',
  },
  dontAsk: {
    peek: 'ran',
    patch: 'denied by dontAsk',
    deploy: 'denied by dontAsk',
    ping: 'ran',
    notify: 'ran',
    rm: 'denied by rule',
    ask_question: 'denied by dontAsk',
  },
};

const CASES = Object.entries(TABLE).flatMap(([mode, row]) => Object.entries(row).map(([toolName, outcome]) => [mode, toolName, outcome] as const));

async function collect(run: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

describe('permission modes (N4)', () => {
  it.each(CASES)('%s mode: a call of %s is %s', async (mode, toolName, expected) => {
    const { outcome } = await outcomeOf(mode as PermissionMode, toolName);
    expect(outcome).toBe(expected);
  });

  it('records the mode in the audit entry only when it changed the outcome', async () => {
    expect((await outcomeOf('plan', 'deploy')).entries).toEqual([
      expect.objectContaining({ toolName: 'deploy', decision: 'deny', reason: PLAN_MODE_REASON, mode: 'plan' }),
    ]);
    // an `allow` rule matched, plan mode still denied: the rule stays in the entry
    expect((await outcomeOf('plan', 'notify')).entries).toEqual([
      expect.objectContaining({ decision: 'deny', mode: 'plan', rule: { index: 0 } }),
    ]);
    expect((await outcomeOf('acceptEdits', 'patch')).entries).toEqual([expect.objectContaining({ decision: 'allow', mode: 'acceptEdits' })]);
    expect((await outcomeOf('dontAsk', 'ask_question')).entries).toEqual([
      expect.objectContaining({ decision: 'deny', reason: DONT_ASK_REASON, mode: 'dontAsk' }),
    ]);
    const [ruled] = (await outcomeOf('plan', 'rm')).entries;
    expect(ruled).toMatchObject({ decision: 'deny', rule: { index: 1, reason: 'No deletes' } });
    expect(ruled.mode).toBeUndefined();
    const [unchanged] = (await outcomeOf('acceptEdits', 'peek')).entries;
    expect(unchanged.decision).toBe('default');
    expect(unchanged.mode).toBeUndefined();
  });

  it('streams permission.decision under a mode even without permissions or onPermissionDecision', async () => {
    const { deploy } = toolbox();
    const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'deploy', id: 'c1' }] }, 'ok']), tools: [deploy.defined], permissionMode: 'plan' });
    const events = await collect(agent.stream('go'));
    const decisions = events.filter((e): e is AgentEventOf<'permission.decision'> => e.type === 'permission.decision');
    expect(decisions).toEqual([expect.objectContaining({ toolName: 'deploy', decision: 'deny', mode: 'plan', reason: PLAN_MODE_REASON })]);
    expect(events.find((e) => e.type === 'tool.error')).toMatchObject({
      error: { name: 'ToolDeniedError', message: `Tool 'deploy' was denied by plan mode: ${PLAN_MODE_REASON}` },
    });
  });

  it('adds the plan-mode paragraph to the system prompt of a run that starts in plan mode, and only then', async () => {
    const planned = mockModel(['ok']);
    await createAgent({ provider: planned, instructions: 'You edit code.', permissionMode: 'plan' }).send('go');
    expect(String(planned.calls[0].messages[0].content)).toBe(`You edit code.\n\n${PLAN_MODE_INSTRUCTION}`);

    const plain = mockModel(['ok']);
    await createAgent({ provider: plain, instructions: 'You edit code.', permissionMode: 'acceptEdits' }).send('go');
    expect(String(plain.calls[0].messages[0].content)).toBe('You edit code.');
  });

  it('keeps the normal not-found error for an unknown tool in plan mode', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'nope', id: 'c1' }] }, 'ok']);
    await createAgent({ provider: model, tools: [toolbox().peek.defined], permissionMode: 'plan' }).send('go');
    expect(firstToolResult(model)).toMatchObject({ kind: 'not-found' });
  });

  it('never turns a deny into a run: a hook deny and a needsApproval deny still deny under acceptEdits and dontAsk', async () => {
    for (const mode of ['acceptEdits', 'dontAsk'] as const) {
      const calls: string[] = [];
      const edit = defineTool({
        name: 'edit',
        description: 'Edits',
        input: z.object({}),
        editsFiles: true,
        needsApproval: () => ({ deny: 'Protected file' }),
        execute: () => calls.push('edit'),
      });
      const hooked = defineTool({ name: 'hooked', description: 'Hooked', input: z.object({}), editsFiles: true, needsApproval: true, execute: () => calls.push('hooked') });
      const model = mockModel([{ toolCalls: [{ name: 'edit', id: 'c1' }, { name: 'hooked', id: 'c2' }] }, 'ok']);
      const agent = createAgent({
        provider: model,
        tools: [edit, hooked],
        permissionMode: mode,
        hooks: [{ name: 'guard', preToolCall: (ctx) => (ctx.toolName === 'hooked' ? { deny: 'Not now' } : undefined) }],
      });
      const result = await agent.send('go');
      expect(result.finishReason).toBe('stop');
      expect(calls).toEqual([]);
      const results = model.calls[1].messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(String(m.content)) as Record<string, unknown>);
      expect(results).toEqual([
        expect.objectContaining({ kind: 'denied', reason: 'Protected file' }),
        expect.objectContaining({ kind: 'denied', reason: 'Not now' }),
      ]);
    }
  });

  it('dontAsk never calls the approve callback: nothing pauses', async () => {
    const approve = vi.fn(() => true);
    const { deploy } = toolbox();
    const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'deploy' }] }, 'ok']), tools: [deploy.defined], permissionMode: 'dontAsk', approve });
    const result = await agent.send('go');
    expect(result.finishReason).toBe('stop');
    expect(approve).not.toHaveBeenCalled();
    expect(deploy.calls).toEqual([]);
  });

  it("send({ permissionMode }) overrides the agent's mode for that run only", async () => {
    const { ping } = toolbox();
    const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'ping' }] }, 'ok'], { onExhausted: 'repeat-last' }), tools: [ping.defined] });
    await agent.send('go', { permissionMode: 'plan' });
    expect(ping.calls).toEqual([]);
  });

  it('reads a function mode at every tool call', async () => {
    const { ping } = toolbox();
    let mode: PermissionMode = 'plan';
    const model = mockModel([{ toolCalls: [{ name: 'ping', id: 'c1' }] }, { toolCalls: [{ name: 'ping', id: 'c2' }] }, 'ok']);
    const agent = createAgent({
      provider: model,
      tools: [ping.defined],
      permissionMode: () => mode,
      onPermissionDecision: () => {
        mode = 'default';
      },
    });
    await agent.send('go');
    expect(ping.calls).toEqual(['ping']);
  });

  it('rejects an unknown mode', async () => {
    expect(() => createAgent({ provider: mockModel(['ok']), permissionMode: 'yolo' as PermissionMode })).toThrow(/unknown permission mode "yolo"/);
    const agent = createAgent({ provider: mockModel(['ok']) });
    await expect(agent.send('go', { permissionMode: 'auto' as PermissionMode })).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
    expect(() => agent.session().setPermissionMode('bypass' as PermissionMode)).toThrow(/unknown permission mode/);
  });
});

describe('permission modes and sub-agents (N4)', () => {
  function writer(workspace: MemoryWorkspace, permissionMode?: PermissionMode) {
    return createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'x' } }] }, 'could not write'], { onExhausted: 'repeat-last' }),
      instructions: 'You write files.',
      tools: createFsTools(workspace),
      description: 'Writes files',
      ...(permissionMode && { permissionMode }),
    });
  }
  const delegate = { toolCalls: [{ name: 'task', args: { agent: 'writer', prompt: 'Write a.txt', description: 'write it' } }] };

  it("a sub-agent run under the lead's plan mode cannot write", async () => {
    const workspace = new MemoryWorkspace();
    const entries: PermissionDecisionEntry[] = [];
    const lead = createAgent({
      provider: mockModel([delegate, 'done']),
      subagents: { writer: writer(workspace) },
      permissionMode: 'plan',
      onPermissionDecision: (entry) => entries.push(entry),
    });
    const result = await lead.send('go');
    expect(result.finishReason).toBe('stop');
    expect(workspace.snapshot()).toEqual({});
    expect(entries.map((e) => [e.toolName, e.decision, e.mode])).toEqual([
      ['task', 'default', undefined],
      ['write_file', 'deny', 'plan'],
    ]);
  });

  it("a sub-agent keeps its own mode while the lead's is 'default'", async () => {
    const workspace = new MemoryWorkspace();
    const lead = createAgent({ provider: mockModel([delegate, 'done']), subagents: { writer: writer(workspace, 'plan') } });
    await lead.send('go');
    expect(workspace.snapshot()).toEqual({});

    const free = new MemoryWorkspace();
    await createAgent({ provider: mockModel([delegate, 'done']), subagents: { writer: writer(free) } }).send('go');
    expect(free.snapshot()).toEqual({ 'a.txt': 'x' });
  });

  it('refuses a remote sub-agent in plan mode without calling it: it does not inherit the mode', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const model = mockModel([{ toolCalls: [{ name: 'task', args: { agent: 'remote', prompt: 'Change it', description: 'change' } }] }, 'ok']);
    const lead = createAgent({ provider: model, subagents: { remote: remoteAgent({ url: 'https://agent.example.test', fetch }) }, permissionMode: 'plan' });
    await lead.send('go');
    expect(fetch).not.toHaveBeenCalled();
    expect(String(firstToolResult(model)?.message)).toContain('does not inherit plan mode');
  });
});

describe('permission modes in sessions (N4)', () => {
  it("starts in plan; setPermissionMode('acceptEdits') from a tool.start listener applies to the next write_file of the same turn", async () => {
    const workspace = new MemoryWorkspace({ files: { 'notes.md': '# Notes\n' } });
    const changes: PermissionModeChange[] = [];
    const agent = createAgent({
      provider: mockModel([
        { toolCalls: [{ name: 'write_file', id: 'w1', args: { path: 'early.md', content: 'x' } }] },
        { toolCalls: [{ name: 'read_file', id: 'r1', args: { path: 'notes.md' } }] },
        { toolCalls: [{ name: 'write_file', id: 'w2', args: { path: 'plan.md', content: 'the plan' } }] },
        'done',
      ]),
      tools: createFsTools(workspace, { needsApproval: { write_file: true } }),
      onPermissionModeChange: (change) => changes.push(change),
    });
    const session = agent.session({ permissionMode: 'plan' });
    expect(session.permissionMode).toBe('plan');
    const run = session.stream('Plan, then write the plan.');
    for await (const event of run) {
      if (event.type === 'tool.start' && event.toolName === 'read_file') session.setPermissionMode('acceptEdits');
    }
    const result = await run.result;

    expect(result.finishReason).toBe('stop');
    expect(Object.keys(workspace.snapshot())).not.toContain('early.md');
    expect(await workspace.readFile('plan.md')).toBe('the plan');
    expect(session.permissionMode).toBe('acceptEdits');
    expect(changes).toEqual([{ sessionId: session.id, from: 'plan', to: 'acceptEdits', at: expect.any(String) }]);
  });

  it("a paused turn resolved after setPermissionMode('dontAsk') follows the new mode for the calls after the approved one", async () => {
    const { deploy } = toolbox();
    const model = mockModel([
      { toolCalls: [{ name: 'deploy', id: 'd1' }] },
      { toolCalls: [{ name: 'deploy', id: 'd2' }] },
      'done',
    ]);
    const agent = createAgent({ provider: model, tools: [deploy.defined] });
    const session = agent.session();
    const paused = await session.send('Deploy twice.');
    expect(paused.finishReason).toBe('awaiting-approval');

    session.setPermissionMode('dontAsk');
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(result.finishReason).toBe('stop');
    expect(deploy.calls).toEqual(['deploy']); // the approved call ran; the next one was refused, not paused
    const second = model.calls[2].messages.filter((m) => m.role === 'tool').at(-1);
    expect(JSON.parse(String(second?.content))).toMatchObject({ kind: 'denied', reason: DONT_ASK_REASON });
    expect(session.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'done' });
  });

  it('a call approved before a switch to plan mode is refused when the turn continues', async () => {
    const { deploy } = toolbox();
    const model = mockModel([{ toolCalls: [{ name: 'deploy', id: 'd1' }] }, 'done']);
    const entries: PermissionDecisionEntry[] = [];
    const agent = createAgent({ provider: model, tools: [deploy.defined], onPermissionDecision: (entry) => entries.push(entry) });
    const session = agent.session();
    const paused = await session.send('Deploy.');
    session.setPermissionMode('plan');
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(result.finishReason).toBe('stop');
    expect(deploy.calls).toEqual([]);
    expect(firstToolResult(model)).toMatchObject({ kind: 'denied', reason: PLAN_MODE_REASON });
    expect(entries.at(-1)).toMatchObject({ toolName: 'deploy', decision: 'deny', mode: 'plan' });
  });

  it("a run paused outside a session continues under the agent's mode, not the send() call's", async () => {
    const { deploy } = toolbox();
    const model = mockModel([{ toolCalls: [{ name: 'deploy', id: 'd1' }] }, { toolCalls: [{ name: 'deploy', id: 'd2' }] }, 'done']);
    const agent = createAgent({ provider: model, tools: [deploy.defined], permissionMode: 'dontAsk' });
    const paused = await agent.send('Deploy twice.', { permissionMode: 'default' });
    expect(paused.finishReason).toBe('awaiting-approval');

    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(result.finishReason).toBe('stop');
    expect(deploy.calls).toEqual(['deploy']);
    const second = model.calls[2].messages.filter((m) => m.role === 'tool').at(-1);
    expect(JSON.parse(String(second?.content))).toMatchObject({ kind: 'denied', reason: DONT_ASK_REASON });
  });
});
