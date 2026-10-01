/**
 * LOU-X2: declarative permission policies - ordered allow/deny/ask rules
 * checked before a tool's `needsApproval`, with an audit trail.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools';
import { mockModel, type MockModel } from '../testing';
import type { AgentConfig } from '../types';
import type { AgentEvent, AgentEventOf } from './agentEvents';
import { AgentExecutor } from './AgentExecutor';
import { allow, ask, deny, type PermissionDecisionEntry, type PermissionRule } from './permissions';

/** A tool named `name` that records its calls; `needsApproval` as given. */
function tool(name: string, needsApproval = false) {
  const calls: unknown[] = [];
  const defined = defineTool({
    name,
    description: `The ${name} tool`,
    input: z.object({ value: z.string().optional() }),
    needsApproval,
    execute: async (args) => {
      calls.push(args);
      return `${name} ran`;
    },
  });
  return { defined, calls };
}

/** The tool results the model saw on its second call, parsed. */
function toolResults(model: MockModel): Array<Record<string, unknown>> {
  return model.calls[1].messages
    .filter((m) => m.role === 'tool')
    .map((m) => JSON.parse(String(m.content)) as Record<string, unknown>);
}

async function collect(run: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

const decisions = (events: AgentEvent[]): AgentEventOf<'permission.decision'>[] =>
  events.filter((e): e is AgentEventOf<'permission.decision'> => e.type === 'permission.decision');

describe('permission policies (LOU-X2)', () => {
  it('allow runs a needsApproval tool without pausing', async () => {
    const email = tool('send_email', true);
    const agent = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'send_email' }] }, 'sent']),
      tools: [email.defined],
      permissions: [allow('send_email')],
    });

    const result = await agent.send('go');

    expect(result.finishReason).toBe('stop');
    expect(email.calls).toHaveLength(1);
    expect(await agent.approvals.list()).toEqual([]);
  });

  it('deny gives the model a structured denied error with the reason and emits tool.error', async () => {
    const shell = tool('shell');
    const model = mockModel([{ toolCalls: [{ name: 'shell', id: 'c1' }] }, 'ok']);
    const agent = createAgent({ provider: model, tools: [shell.defined], permissions: [deny('shell', 'No shell in prod')] });

    const events = await collect(agent.stream('go'));

    expect(shell.calls).toHaveLength(0);
    expect(toolResults(model)).toEqual([
      expect.objectContaining({ error: 'ToolDeniedError', kind: 'denied', toolName: 'shell', reason: 'No shell in prod' }),
    ]);
    expect(String(toolResults(model)[0].message)).toContain('No shell in prod');
    expect(events.find((e) => e.type === 'tool.error')).toMatchObject({
      toolCallId: 'c1',
      error: { name: 'ToolDeniedError', message: "Tool 'shell' was denied by a permission rule: No shell in prod" },
    });
    expect(decisions(events)).toEqual([
      expect.objectContaining({ toolCallId: 'c1', toolName: 'shell', decision: 'deny', rule: { index: 0, reason: 'No shell in prod' } }),
    ]);
    const types = events.map((e) => e.type);
    expect(types.indexOf('tool.start')).toBeLessThan(types.indexOf('permission.decision'));
  });

  it('ask pauses a tool that does not need approval, and the run resumes when approved', async () => {
    const write = tool('write_file');
    const agent = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'write_file' }] }, 'written']),
      tools: [write.defined],
      permissions: [ask('write_file')],
    });

    const paused = await agent.send('go');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(write.calls).toHaveLength(0);

    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(result.text).toBe('written');
    expect(write.calls).toHaveLength(1);
  });

  it('ask goes through the approve callback when one is set', async () => {
    const write = tool('write_file');
    const approve = vi.fn(() => false);
    const agent = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'write_file' }] }, 'not written']),
      tools: [write.defined],
      permissions: [ask('*')],
      approve,
    });

    const result = await agent.send('go');

    expect(approve).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('not written');
    expect(write.calls).toHaveLength(0);
  });

  it('matches tools by name list and by pattern', async () => {
    const tools = ['read_a', 'read_b', 'danger_rm', 'other'].map((name) => tool(name, true));
    const audit: PermissionDecisionEntry[] = [];
    const agent = createAgent({
      provider: mockModel([{ toolCalls: tools.map((t) => ({ name: t.defined.name })) }, 'done']),
      tools: tools.map((t) => t.defined),
      permissions: [deny(/^danger_/), allow(['read_a', 'read_b'])],
      onPermissionDecision: (entry) => audit.push(entry),
    });

    const result = await agent.send('go');

    expect(audit.map((e) => [e.toolName, e.decision])).toEqual([
      ['read_a', 'allow'],
      ['read_b', 'allow'],
      ['danger_rm', 'deny'],
      ['other', 'default'],
    ]);
    // `other` matched no rule, so its own needsApproval pauses the run.
    expect(result.finishReason).toBe('awaiting-approval');
    expect(tools.map((t) => t.calls.length)).toEqual([1, 1, 0, 0]);
  });

  it('a rule applies only when its async `when` predicate returns true', async () => {
    const shell = tool('shell');
    const when = vi.fn(async (args: Record<string, unknown>) => String(args.value).startsWith('rm'));
    const model = mockModel([
      { toolCalls: [{ name: 'shell', args: { value: 'rm -rf /' } }, { name: 'shell', args: { value: 'ls' } }] },
      'done',
    ]);
    const agent = createAgent({
      provider: model,
      tools: [shell.defined],
      permissions: [{ tool: 'shell', when, action: 'deny', reason: 'No deletes' }],
    });

    await agent.send('go');

    expect(shell.calls).toEqual([{ value: 'ls' }]);
    expect(toolResults(model)[0]).toMatchObject({ kind: 'denied', reason: 'No deletes' });
    expect(when).toHaveBeenCalledWith({ value: 'rm -rf /' }, { toolName: 'shell', toolCallId: 'call_1', sessionId: undefined });
  });

  it('a throwing `when` becomes the call error, like a throwing needsApproval', async () => {
    const shell = tool('shell');
    const model = mockModel([{ toolCalls: [{ name: 'shell' }] }, 'done']);
    const rule: PermissionRule = { tool: '*', action: 'allow', when: () => { throw new Error('policy store down'); } };
    const agent = createAgent({ provider: model, tools: [shell.defined], permissions: [rule] });

    await agent.send('go');

    expect(shell.calls).toHaveLength(0);
    expect(toolResults(model)[0]).toMatchObject({ kind: 'execution', message: 'policy store down' });
  });

  it('the first matching rule wins', async () => {
    const [a, b] = [tool('a', true), tool('b')];
    const audit: PermissionDecisionEntry[] = [];
    const agent = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'a' }, { name: 'b' }] }, 'done']),
      tools: [a.defined, b.defined],
      permissions: [allow('a'), deny('*', 'Only a'), allow('b')],
      onPermissionDecision: (entry) => audit.push(entry),
    });

    await agent.send('go');

    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
    expect(audit.map((e) => [e.toolName, e.decision, e.rule?.index])).toEqual([
      ['a', 'allow', 0],
      ['b', 'deny', 1],
    ]);
  });

  it('writes an audit entry per call, with the args unless redactContent is set', async () => {
    const lookup = tool('lookup');
    const entries = async (redactContent: boolean) => {
      const audit: PermissionDecisionEntry[] = [];
      const toolRegistry = new ToolRegistry();
      toolRegistry.registerMany([lookup.defined]);
      const agent: AgentConfig = { id: 'a1', name: 'A', prompt: 'p', tools: { lookup: { tool: 'lookup' } } };
      await AgentExecutor.execute({
        agent,
        toolRegistry,
        input: 'go',
        provider: mockModel([{ toolCalls: [{ name: 'lookup', id: 'x1', args: { value: 'secret' } }] }, 'done']),
        onPermissionDecision: (entry) => audit.push(entry),
        redactContent,
      });
      return audit;
    };

    const [entry] = await entries(false);
    expect(entry).toEqual({ toolName: 'lookup', toolCallId: 'x1', decision: 'default', args: { value: 'secret' }, at: expect.any(String) });
    expect(new Date(entry.at).toISOString()).toBe(entry.at);
    expect(await entries(true)).toEqual([{ toolName: 'lookup', toolCallId: 'x1', decision: 'default', at: expect.any(String) }]);
  });

  it('streams no permission.decision events when no policy is configured', async () => {
    const lookup = tool('lookup');
    const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'lookup' }] }, 'done']), tools: [lookup.defined] });

    expect(decisions(await collect(agent.stream('go')))).toEqual([]);
  });

  it("sub-agents inherit the parent's rules, ahead of their own", async () => {
    const lookup = tool('lookup');
    const fetchPage = tool('fetch_page');
    const researcher = createAgent({
      name: 'researcher',
      description: 'Researches',
      provider: mockModel([{ toolCalls: [{ name: 'lookup' }, { name: 'fetch_page' }] }, 'found nothing']),
      tools: [lookup.defined, fetchPage.defined],
      permissions: [allow('*')],
    });
    const audit: PermissionDecisionEntry[] = [];
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'task', args: { agent: 'researcher', prompt: 'look', description: 'look' } }] }, 'done']),
      subagents: { researcher },
      permissions: [deny('lookup', 'Not for sub-agents')],
      onPermissionDecision: (entry) => audit.push(entry),
    });

    const events = await collect(lead.stream('go'));

    expect(lookup.calls).toHaveLength(0);
    expect(fetchPage.calls).toHaveLength(1);
    expect(audit.map((e) => [e.toolName, e.decision])).toEqual([
      ['task', 'default'],
      ['lookup', 'deny'],
      ['fetch_page', 'allow'],
    ]);
    expect(decisions(events).filter((e) => e.subagent).map((e) => e.toolName)).toEqual(['lookup', 'fetch_page']);
  });
});
