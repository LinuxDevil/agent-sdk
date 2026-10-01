/**
 * LOU-X8: `needsApproval` outcomes ('approve' | 'deny' | 'ask' | { deny })
 * and the always() / never() / once() helpers.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from './defineTool';
import { always, never, once } from './approvalPolicies';
import { allow, ask, deny, type PermissionDecisionEntry } from '../execution/permissions';
import { InMemoryApprovalStore } from '../execution/InMemoryApprovalStore';
import { SqliteStore } from '../storage/sqlite';
import { mockModel, type MockModel, type MockTurn } from '../testing';
import type { AgentEvent } from '../execution/agentEvents';
import type { DefineToolOptions } from './defineTool';

type Policy = DefineToolOptions<z.ZodObject<{ value: z.ZodOptional<z.ZodString> }>, string>['needsApproval'];

/** A `deploy` tool with the given `needsApproval`, recording the values it ran with. */
function deployTool(needsApproval: Policy) {
  const ran: Array<string | undefined> = [];
  const defined = defineTool({
    name: 'deploy',
    description: 'Deploy',
    input: z.object({ value: z.string().optional() }),
    needsApproval,
    execute: async ({ value }) => {
      ran.push(value);
      return 'deployed';
    },
  });
  return { defined, ran };
}

const call = (value?: string): MockTurn => ({ toolCalls: [{ name: 'deploy', args: value === undefined ? {} : { value } }] });

/** The tool results the model saw on its `n`-th call, parsed. */
function toolResults(model: MockModel, n = 1): Array<Record<string, unknown>> {
  return model.calls[n].messages
    .filter((m) => m.role === 'tool')
    .map((m) => JSON.parse(String(m.content)) as Record<string, unknown>);
}

async function collect(run: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

describe('needsApproval outcomes (LOU-X8)', () => {
  it('a deny with a reason reaches the model as a denied tool error, and the run continues', async () => {
    const deploy = deployTool(async () => ({ deny: 'Deploys are frozen today' }));
    const model = mockModel([call('api'), 'I will not deploy.']);
    const audit: PermissionDecisionEntry[] = [];
    const agent = createAgent({ provider: model, tools: [deploy.defined], onPermissionDecision: (e) => audit.push(e) });

    const events = await collect(agent.stream('deploy'));

    expect(deploy.ran).toEqual([]);
    expect(toolResults(model)[0]).toMatchObject({ error: 'ToolDeniedError', kind: 'denied', toolName: 'deploy', reason: 'Deploys are frozen today' });
    expect(events.find((e) => e.type === 'tool.error')).toMatchObject({
      error: { name: 'ToolDeniedError', message: "Tool 'deploy' was denied by its needsApproval policy: Deploys are frozen today" },
    });
    expect(events.at(-1)).toMatchObject({ type: 'run.done', text: 'I will not deploy.', finishReason: 'stop' });
    expect(audit).toEqual([expect.objectContaining({ toolName: 'deploy', decision: 'deny', reason: 'Deploys are frozen today' })]);
    expect(audit[0].rule).toBeUndefined();
  });

  it("'deny' denies without a reason, 'approve' runs, 'ask' pauses", async () => {
    const outcome = { value: 'deny' as 'deny' | 'approve' | 'ask' };
    const deploy = deployTool(() => outcome.value);
    const model = mockModel([call('a'), 'denied', call('b'), 'ran', call('c')]);
    const agent = createAgent({ provider: model, tools: [deploy.defined] });

    await agent.send('go');
    expect(toolResults(model)[0]).toMatchObject({ kind: 'denied', message: "Tool 'deploy' was denied by its needsApproval policy" });
    outcome.value = 'approve';
    expect((await agent.send('go')).text).toBe('ran');
    outcome.value = 'ask';
    expect((await agent.send('go')).finishReason).toBe('awaiting-approval');
    expect(deploy.ran).toEqual(['b']);
  });

  it('always() and never() are needsApproval true and false', async () => {
    expect(always()).toBe(true);
    expect(never()).toBe(false);
    const deploy = deployTool(never());
    const agent = createAgent({ provider: mockModel([call(), 'done']), tools: [deploy.defined] });
    expect((await agent.send('go')).text).toBe('done');
  });
});

describe('once() (LOU-X8)', () => {
  it('asks the first time in a session, then approves later calls; a new session asks again', async () => {
    const deploy = deployTool(once());
    const agent = createAgent({ provider: mockModel([call('a'), 'one', call('b'), 'two', call('c')]), tools: [deploy.defined] });
    const session = agent.session();

    const paused = await session.send('deploy a');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect((await agent.approvals.resolve({ id: paused.approvalId!, approved: true })).text).toBe('one');
    expect((await session.send('deploy b')).text).toBe('two');
    expect(deploy.ran).toEqual(['a', 'b']);

    expect((await agent.session().send('deploy c')).finishReason).toBe('awaiting-approval');
  });

  it('approves a later call of the same run once the first is approved (also when streamed)', async () => {
    const deploy = deployTool(once());
    const agent = createAgent({ provider: mockModel([call('a'), call('b'), 'both']), tools: [deploy.defined] });

    const paused = await agent.send('deploy twice');
    const events = await collect(agent.approvals.streamResolve({ id: paused.approvalId!, approved: true }));

    expect(events.at(-1)).toMatchObject({ type: 'run.done', text: 'both' });
    expect(deploy.ran).toEqual(['a', 'b']);
  });

  it('does not remember a rejection', async () => {
    const deploy = deployTool(once());
    const agent = createAgent({ provider: mockModel([call('a'), 'rejected', call('b')]), tools: [deploy.defined] });
    const session = agent.session();

    const paused = await session.send('deploy a');
    await agent.approvals.resolve({ id: paused.approvalId!, approved: false });

    expect((await session.send('deploy b')).finishReason).toBe('awaiting-approval');
    expect(deploy.ran).toEqual([]);
  });

  it("per: 'args' remembers approvals per arguments", async () => {
    const deploy = deployTool(once({ per: 'args' }));
    const agent = createAgent({ provider: mockModel([call('a'), call('a'), call('b')]), tools: [deploy.defined] });

    const first = await agent.send('go');
    const second = await agent.approvals.resolve({ id: first.approvalId!, approved: true });

    expect(deploy.ran).toEqual(['a', 'a']);
    expect(second.finishReason).toBe('awaiting-approval');
    expect((await agent.approvals.list())[0].args).toEqual({ value: 'b' });
  });

  it('survives a resume through a fresh agent on the same store', async () => {
    const store = new SqliteStore(':memory:');
    const approvalStore = new InMemoryApprovalStore();
    const before = deployTool(once());
    const paused = await createAgent({ provider: mockModel([call('a')]), tools: [before.defined], approvalStore })
      .session({ id: 'chat', store })
      .send('deploy a');
    expect(paused.finishReason).toBe('awaiting-approval');

    const deploy = deployTool(once());
    const agent = createAgent({ provider: mockModel([call('b'), 'two', call('c'), 'three']), tools: [deploy.defined], approvalStore });
    const session = agent.session({ id: 'chat', store });
    await expect(session.resume()).rejects.toMatchObject({ name: 'SessionAwaitingApprovalError' });

    expect((await agent.approvals.resolve({ id: paused.approvalId!, approved: true })).text).toBe('two');
    expect((await session.send('deploy c')).text).toBe('three');
    expect(deploy.ran).toEqual(['a', 'b', 'c']);
    store.close();
  });
});

describe('precedence with permissions (LOU-X8)', () => {
  it('a permissions deny wins over an approving needsApproval', async () => {
    const deploy = deployTool(() => 'approve');
    const model = mockModel([call(), 'ok']);
    const agent = createAgent({ provider: model, tools: [deploy.defined], permissions: [deny('deploy', 'No')] });

    await agent.send('go');

    expect(deploy.ran).toEqual([]);
    expect(toolResults(model)[0]).toMatchObject({ kind: 'denied', reason: 'No' });
  });

  it("a permissions allow skips the tool's ask, an ask rule pauses a tool that never asks", async () => {
    const asks = deployTool(always());
    await createAgent({ provider: mockModel([call('a'), 'ok']), tools: [asks.defined], permissions: [allow('deploy')] }).send('go');
    expect(asks.ran).toEqual(['a']);

    const neverAsks = deployTool(never());
    const result = await createAgent({ provider: mockModel([call('b')]), tools: [neverAsks.defined], permissions: [ask('deploy')] }).send('go');
    expect(result.finishReason).toBe('awaiting-approval');
  });

  it("a permissions allow or ask does not override the tool's own deny (LOU-X3 follow-up)", async () => {
    for (const rule of [allow('deploy'), ask('deploy')]) {
      const deploy = deployTool(() => ({ deny: 'Frozen' }));
      const model = mockModel([call('a'), 'ok']);
      await createAgent({ provider: model, tools: [deploy.defined], permissions: [rule] }).send('go');
      expect(deploy.ran).toEqual([]);
      expect(toolResults(model)[0]).toMatchObject({ kind: 'denied', reason: 'Frozen' });
    }
  });

  it("with no matching rule, the tool's outcome applies", async () => {
    const deploy = deployTool(() => ({ deny: 'Not today' }));
    const model = mockModel([call(), 'ok']);
    const agent = createAgent({ provider: model, tools: [deploy.defined], permissions: [allow('other_tool')] });

    await agent.send('go');

    expect(toolResults(model)[0]).toMatchObject({ kind: 'denied', reason: 'Not today' });
  });
});

describe('sub-agents (LOU-X8)', () => {
  const task = { toolCalls: [{ name: 'task', args: { agent: 'ops', prompt: 'deploy', description: 'deploy' } }] };

  it("a sub-agent's tool deny reaches the sub-agent's model", async () => {
    const deploy = deployTool(() => ({ deny: 'Frozen' }));
    const childModel = mockModel([call(), 'could not deploy']);
    const ops = createAgent({ name: 'ops', description: 'Ops', provider: childModel, tools: [deploy.defined] });
    const lead = createAgent({ provider: mockModel([task, 'done']), subagents: { ops } });

    expect((await lead.send('go')).text).toBe('done');
    expect(toolResults(childModel)[0]).toMatchObject({ kind: 'denied', reason: 'Frozen' });
  });

  it("once() in a sub-agent asks through the lead, then approves the sub-agent's next call", async () => {
    const deploy = deployTool(once());
    const ops = createAgent({ name: 'ops', description: 'Ops', provider: mockModel([call('a'), call('b'), 'deployed twice']), tools: [deploy.defined] });
    const lead = createAgent({ provider: mockModel([task, 'done']), subagents: { ops } });

    const paused = await lead.send('go');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect((await lead.approvals.resolve({ id: paused.approvalId!, approved: true })).text).toBe('done');
    expect(deploy.ran).toEqual(['a', 'b']);
  });
});
