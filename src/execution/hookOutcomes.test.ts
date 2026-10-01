/**
 * LOU-X3: hook outcomes - a preToolCall hook may deny a call, supply its
 * result or modify its input; a postToolCall hook may replace the result.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockModel, type MockTurn } from '../testing';
import type { AgentEvent } from './agentEvents';
import type { AgentHook } from './hooks';
import type { PermissionDecisionEntry } from './permissions';

/** A `search` tool recording the queries it ran with. */
function searchTool(needsApproval?: (args: { query: string; limit: number }) => 'ask' | 'approve' | { deny: string }) {
  const ran: Array<{ query: string; limit: number }> = [];
  const defined = defineTool({
    name: 'search',
    description: 'Search',
    input: z.object({ query: z.string(), limit: z.number().max(10).default(5) }),
    ...(needsApproval && { needsApproval }),
    execute: async (args) => {
      ran.push(args);
      return `found ${args.query}`;
    },
  });
  return { defined, ran };
}

const call = (query: string, limit?: number): MockTurn => ({
  toolCalls: [{ name: 'search', args: limit === undefined ? { query } : { query, limit } }],
});

/** The tool results the model saw on its `n`-th call, parsed. */
function toolResults(model: MockModel, n = 1): unknown[] {
  return model.calls[n].messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(String(m.content)) as unknown);
}

async function collect(run: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

describe('preToolCall outcomes (LOU-X3)', () => {
  it('{ deny } skips the call, gives the model a denied result, streams tool.error and audits it', async () => {
    const search = searchTool();
    const model = mockModel([call('secrets'), 'ok']);
    const audit: PermissionDecisionEntry[] = [];
    const later: string[] = [];
    const hooks: AgentHook[] = [
      { name: 'policy', preToolCall: (ctx) => (String(ctx.args.query).includes('secret') ? { deny: 'No secrets' } : undefined) },
      { name: 'later', preToolCall: (ctx) => void later.push(ctx.toolName) },
    ];
    const agent = createAgent({ provider: model, tools: [search.defined], hooks, onPermissionDecision: (e) => audit.push(e) });

    const events = await collect(agent.stream('go'));

    expect(search.ran).toEqual([]);
    expect(later).toEqual([]);
    expect(toolResults(model)[0]).toMatchObject({ error: 'ToolDeniedError', kind: 'denied', reason: 'No secrets' });
    expect(events.find((e) => e.type === 'tool.error')).toMatchObject({
      error: { name: 'ToolDeniedError', message: "Tool 'search' was denied by hook 'policy': No secrets" },
    });
    expect(audit).toEqual([expect.objectContaining({ toolName: 'search', decision: 'deny', hook: 'policy', reason: 'No secrets' })]);
    expect(events.at(-1)).toMatchObject({ type: 'run.done', text: 'ok' });
  });

  it('{ result } skips the call and becomes its result, marked as replaced by the hook', async () => {
    const search = searchTool();
    const model = mockModel([call('cached'), 'ok']);
    const cache: AgentHook = { name: 'cache', preToolCall: () => ({ result: { hits: ['from cache'] } }) };
    const agent = createAgent({ provider: model, tools: [search.defined], hooks: [cache] });

    const events = await collect(agent.stream('go'));

    expect(search.ran).toEqual([]);
    expect(toolResults(model)[0]).toEqual({ hits: ['from cache'] });
    expect(events.find((e) => e.type === 'tool.done')).toMatchObject({ result: { hits: ['from cache'] }, replacedByHook: 'cache' });
    expect(model.calls[1].messages.find((m) => m.role === 'tool')?.metadata).toEqual({ replacedByHook: 'cache' });
  });

  it('{ input } chains: each hook sees the previous input, and the tool runs with the last one', async () => {
    const search = searchTool();
    const seen: unknown[] = [];
    const hooks: AgentHook[] = [
      { name: 'trim', preToolCall: (ctx) => ({ input: { ...ctx.args, query: String(ctx.args.query).trim() } }) },
      { name: 'cap', preToolCall: (ctx) => (seen.push({ ...ctx.args }), { input: { ...ctx.args, limit: 3 } }) },
    ];
    await createAgent({ provider: mockModel([call('  cats  ', 9), 'ok']), tools: [search.defined], hooks }).send('go');

    expect(seen).toEqual([{ query: 'cats', limit: 9 }]);
    expect(search.ran).toEqual([{ query: 'cats', limit: 3 }]);
  });

  it('{ input } is validated again; a mismatch is an error naming the hook, and the tool does not run', async () => {
    const search = searchTool();
    const model = mockModel([call('cats'), 'ok']);
    const bad: AgentHook = { name: 'bad', preToolCall: (ctx) => ({ input: { ...ctx.args, limit: 50 } }) };
    await createAgent({ provider: model, tools: [search.defined], hooks: [bad] }).send('go');

    expect(search.ran).toEqual([]);
    const [result] = toolResults(model) as Array<{ kind: string; hook: string; message: string }>;
    expect(result).toMatchObject({ kind: 'validation', hook: 'bad' });
    expect(result.message).toMatch(/^Input from hook 'bad' for tool 'search' was refused: /);
  });

  it('nothing (or an unrelated return value) keeps the call unchanged', async () => {
    const search = searchTool();
    const hooks = [{ name: 'noop', preToolCall: () => 42 }] as unknown as AgentHook[];
    expect((await createAgent({ provider: mockModel([call('cats'), 'ok']), tools: [search.defined], hooks }).send('go')).text).toBe('ok');
    expect(search.ran).toEqual([{ query: 'cats', limit: 5 }]);
  });

  it('a throwing hook still rejects the run (unchanged behavior)', async () => {
    const boom: AgentHook = { name: 'boom', preToolCall: () => { throw new Error('rate limited'); } };
    const agent = createAgent({ provider: mockModel([call('cats'), 'ok']), tools: [searchTool().defined], hooks: [boom] });
    await expect(agent.send('go')).rejects.toThrow('rate limited');
  });
});

describe('postToolCall outcomes (LOU-X3)', () => {
  it('{ result } replaces what the model sees; later hooks see the replacement', async () => {
    const model = mockModel([call('cats'), 'ok']);
    const seen: unknown[] = [];
    const hooks: AgentHook[] = [
      { name: 'redact', postToolCall: (_ctx, result) => ({ result: String(result.result).replace('cats', '[redacted]') }) },
      { name: 'spy', postToolCall: (_ctx, result) => void seen.push(result.result) },
    ];
    const events = await collect(createAgent({ provider: model, tools: [searchTool().defined], hooks }).stream('go'));

    expect(toolResults(model)[0]).toBe('found [redacted]');
    expect(seen).toEqual(['found [redacted]']);
    expect(events.find((e) => e.type === 'tool.done')).toMatchObject({ result: 'found [redacted]', replacedByHook: 'redact' });
  });
});

describe('order of evaluation (LOU-X3)', () => {
  it('permission rules and needsApproval see the hook-modified input; the approval record shows it', async () => {
    const asked: unknown[] = [];
    const search = searchTool((args) => (asked.push(args), 'ask'));
    const ruled: unknown[] = [];
    const cap: AgentHook = { name: 'cap', preToolCall: (ctx) => ({ input: { ...ctx.args, limit: 1 } }) };
    const agent = createAgent({
      provider: mockModel([call('cats', 9), 'done']),
      tools: [search.defined],
      hooks: [cap],
      permissions: [{ tool: 'search', when: (args) => (ruled.push(args), false), action: 'deny' }],
    });

    const paused = await agent.send('go');

    expect(ruled).toEqual([{ query: 'cats', limit: 1 }]);
    expect(asked).toEqual([{ query: 'cats', limit: 1 }]);
    expect((await agent.approvals.list())[0].args).toEqual({ query: 'cats', limit: 1 });
    expect((await agent.approvals.resolve({ id: paused.approvalId!, approved: true })).text).toBe('done');
    expect(search.ran).toEqual([{ query: 'cats', limit: 1 }]);
  });

  it('on a resumed call, hook input that differs from the approved input is refused (also streamed)', async () => {
    const search = searchTool(() => 'ask');
    let limit = 1;
    const cap: AgentHook = { name: 'cap', preToolCall: (ctx) => ({ input: { ...ctx.args, limit } }) };
    const model = mockModel([call('cats', 9), 'done']);
    const agent = createAgent({ provider: model, tools: [search.defined], hooks: [cap] });

    const paused = await agent.send('go');
    limit = 2;
    const events = await collect(agent.approvals.streamResolve({ id: paused.approvalId!, approved: true }));

    expect(search.ran).toEqual([]);
    expect(toolResults(model)[0]).toMatchObject({ kind: 'validation', hook: 'cap' });
    expect(events.find((e) => e.type === 'tool.error')).toMatchObject({ error: { message: expect.stringContaining('approved with different input') } });
  });

  it('on a resumed call, a hook may still supply the result', async () => {
    const search = searchTool(() => 'ask');
    let resumed = false;
    const cache: AgentHook = { name: 'cache', preToolCall: () => (resumed ? { result: 'cached' } : undefined) };
    const model = mockModel([call('cats'), 'done']);
    const agent = createAgent({ provider: model, tools: [search.defined], hooks: [cache] });

    const paused = await agent.send('go');
    resumed = true;
    await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(search.ran).toEqual([]);
    expect(toolResults(model)[0]).toBe('cached');
    expect(model.calls[1].messages.find((m) => m.role === 'tool')?.metadata).toMatchObject({ replacedByHook: 'cache' });
  });
});

describe('sub-agents inherit hook outcomes (LOU-X3)', () => {
  it("a lead's preToolCall deny reaches the sub-agent's model", async () => {
    const search = searchTool();
    const childModel = mockModel([call('cats'), 'could not search']);
    const researcher = createAgent({ name: 'researcher', description: 'Researches', provider: childModel, tools: [search.defined] });
    const deny: AgentHook = { name: 'no-search', preToolCall: (ctx) => (ctx.toolName === 'search' ? { deny: 'Offline' } : undefined) };
    const task = { toolCalls: [{ name: 'task', args: { agent: 'researcher', prompt: 'look', description: 'look' } }] };
    const lead = createAgent({ provider: mockModel([task, 'done']), subagents: { researcher }, hooks: [deny] });

    expect((await lead.send('go')).text).toBe('done');
    expect(search.ran).toEqual([]);
    expect(toolResults(childModel)[0]).toMatchObject({ kind: 'denied', reason: 'Offline' });
  });
});
