/**
 * Memory slots on continued runs: a run continued by `approvals.resolve()`, and
 * a session turn resumed after a crash, keep the memory tools (and scope keys)
 * the run started with.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { PropagatingToolError } from '../execution/AgentExecutor';
import { mockModel, type MockRequest } from '../testing';
import { memoryStore } from '../storage/agentStore';
import { defineMemory, inMemoryMemory } from './index';

const toolsOf = (call: MockRequest | undefined): string[] => (call?.tools ?? []).map((t) => t.function.name);

function facts() {
  const provider = inMemoryMemory();
  const slot = defineMemory({
    name: 'facts',
    scope: (ctx) => (typeof ctx.metadata?.userId === 'string' ? `user:${ctx.metadata.userId}` : undefined),
    provider,
  });
  return { provider, slot };
}

describe('memory on continued runs', () => {
  it('a run continued by approvals.resolve() keeps its memory tools, bound to the scope it paused with', async () => {
    const { provider, slot } = facts();
    const deploy = defineTool({ name: 'deploy', description: 'deploy', input: z.object({}), needsApproval: true, execute: async () => 'deployed' });
    const model = mockModel([
      { toolCalls: [{ name: 'deploy', id: 'call_deploy' }] },
      { toolCalls: [{ name: 'remember_facts', id: 'call_mem', args: { text: 'deployed v2' } }] },
      'Done.',
    ]);
    const agent = createAgent({ provider: model, tools: [deploy], memory: [slot], store: memoryStore() });
    const paused = await agent.session({ id: 's1' }).send('ship it', { metadata: { userId: 'alice' } });
    expect(paused.finishReason).toBe('awaiting-approval');

    const done = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(done.text).toBe('Done.');
    expect(toolsOf(model.calls[1])).toEqual(expect.arrayContaining(['deploy', 'remember_facts', 'recall_facts']));
    expect((await provider.list('facts#user:alice')).map((item) => item.text)).toEqual(['deployed v2']);
  });

  it('a crashed session turn whose memory is scoped by metadata resumes without the metadata', async () => {
    const { provider, slot } = facts();
    let crashed = false;
    const boom = defineTool({
      name: 'boom',
      description: 'boom',
      input: z.object({}),
      execute: async () => {
        if (!crashed) {
          crashed = true;
          throw new PropagatingToolError('process died');
        }
        return 'ok';
      },
    });
    const store = memoryStore();
    const turn = { toolCalls: [{ name: 'boom', id: 'call_boom' }, { name: 'remember_facts', id: 'call_mem', args: { text: 'likes tea' } }] };
    const first = createAgent({ provider: mockModel([turn]), tools: [boom], memory: [slot], store });
    await expect(first.session({ id: 's1' }).send('remember', { metadata: { userId: 'alice' } })).rejects.toThrow('process died');

    const second = createAgent({ provider: mockModel(['Noted.']), tools: [boom], memory: [slot], store });
    const resumed = await second.session({ id: 's1' }).resume();

    expect(resumed?.text).toBe('Noted.');
    expect((await provider.list('facts#user:alice')).map((item) => item.text)).toEqual(['likes tea']);
  });
});
