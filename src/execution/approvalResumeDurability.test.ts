/**
 * An approval resume keeps the paused run's checkpoint until the approved call's
 * result is saved (a crash mid-call neither loses the turn nor re-runs the call
 * silently), and refuses a stale approval whose run no longer waits on it.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { PropagatingToolError } from './AgentExecutor';
import { mockModel, type MockRequest } from '../testing';
import { memoryStore } from '../storage/agentStore';

const lastToolResult = (request: MockRequest | undefined) => JSON.parse(String([...(request?.messages ?? [])].reverse().find((m) => m.role === 'tool')?.content));

describe('approval resume durability', () => {
  it('an approved call that dies before its result is saved is reported as interrupted on resume, not lost and not run again', async () => {
    const store = memoryStore();
    let runs = 0;
    const deploy = defineTool({
      name: 'deploy',
      description: 'deploy',
      input: z.object({}),
      needsApproval: true,
      execute: async () => {
        runs++;
        throw new PropagatingToolError('process died while deploying');
      },
    });
    const first = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'deploy', id: 'call_deploy' }] }]), tools: [deploy], store });
    const paused = await first.session({ id: 's1' }).send('deploy please');
    await expect(first.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toThrow('process died');

    expect(await first.pending()).toMatchObject([{ sessionId: 's1', status: 'in-progress' }]);
    const model = mockModel(['It may not have deployed; please check.']);
    const second = createAgent({ provider: model, tools: [deploy], store });
    const resumed = await second.session({ id: 's1' }).resume();

    expect(resumed?.text).toBe('It may not have deployed; please check.');
    expect(runs).toBe(1);
    expect(lastToolResult(model.calls[0])).toMatchObject({ kind: 'interrupted', toolName: 'deploy' });
    const transcript = await second.session({ id: 's1' }).load();
    expect(transcript.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(await second.pending()).toEqual([]);
  });

  it('a stale approval does not come back after its run was deleted and a newer conversation took the id', async () => {
    const store = memoryStore();
    let refunds = 0;
    const refund = defineTool({ name: 'refund', description: 'refund', input: z.object({}), needsApproval: true, execute: async () => `refunded ${++refunds}` });
    const agent = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'refund', id: 'call_refund' }] }, 'hi there', 'refund done'], { onExhausted: 'repeat-last' }),
      tools: [refund],
      store,
    });
    const paused = await agent.send('refund me', { sessionId: 'chat' });
    await store.checkpoints.delete('chat'); // "start over under the same id"
    await agent.send('hello', { sessionId: 'chat' });
    const fresh = await store.checkpoints.load('chat');

    await expect(agent.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toMatchObject({ code: 'LOUSHO_APPROVAL_ORPHANED' });
    expect(refunds).toBe(0);
    expect(await store.checkpoints.load('chat')).toEqual(fresh);
    expect(await agent.approvals.list()).toEqual([]);
    await expect(agent.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toMatchObject({ code: 'LOUSHO_APPROVAL_NOT_FOUND' });
  });

  it("a resumed run that pauses again on a step's several calls records every pending approval id", async () => {
    const store = memoryStore();
    const log: string[] = [];
    const make = (name: string) =>
      defineTool({
        name,
        description: name,
        input: z.object({ n: z.number() }),
        needsApproval: true,
        execute: async ({ n }) => {
          log.push(`${name}(${n})`);
          return 'ok';
        },
      });
    const first = {
      toolCalls: [
        { name: 'wire_money', args: { n: 1 }, id: 'call_wire' },
        { name: 'delete_db', args: { n: 2 }, id: 'call_delete' },
      ],
    };
    const second = {
      toolCalls: [
        { name: 'wire_money', args: { n: 3 }, id: 'call_wire2' },
        { name: 'delete_db', args: { n: 4 }, id: 'call_delete2' },
      ],
    };
    const worker = createAgent({ provider: mockModel([first, second, 'worker done']), tools: [make('wire_money'), make('delete_db')], description: 'Does risky things' });
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'task', args: { agent: 'worker', prompt: 'do it', description: 'risky' }, id: 'call_task' }] }, 'lead done']),
      subagents: { worker },
      store,
    });
    const session = lead.session({ id: 's1' });
    const paused = await session.send('go');
    expect(paused.approvalIds).toHaveLength(2);

    await lead.approvals.resolve({ id: paused.approvalIds![0], approved: true });
    const repaused = await lead.approvals.resolve({ id: paused.approvalIds![1], approved: true });

    // The sub-agent's next step paused on two calls too: the durable reader sees both, not just the first.
    expect(repaused.finishReason).toBe('awaiting-approval');
    expect(repaused.approvalIds).toHaveLength(2);
    const pending = await session.pending();
    expect(pending).toMatchObject({ status: 'awaiting-approval', approvalId: repaused.approvalIds![0], approvalIds: repaused.approvalIds });
    expect(log).toEqual(['wire_money(1)', 'delete_db(2)']);
  });

  it("discardPending() withdraws the dropped turn's approvals", async () => {
    const store = memoryStore();
    const refund = defineTool({ name: 'refund', description: 'refund', input: z.object({}), needsApproval: true, execute: async () => 'refunded' });
    const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'refund', id: 'call_refund' }] }]), tools: [refund], store });
    const session = agent.session({ id: 's1' });
    const paused = await session.send('refund me');
    expect((await agent.approvals.list()).map((approval) => approval.id)).toEqual([paused.approvalId]);

    await session.discardPending();

    expect(await agent.approvals.list()).toEqual([]);
    await expect(agent.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toMatchObject({ code: 'LOUSHO_APPROVAL_NOT_FOUND' });
  });
});
