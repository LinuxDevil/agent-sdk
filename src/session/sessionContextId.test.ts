/**
 * Eve DUI-F5: a checkpointed session's turn is checkpointed under
 * `<id>.turn-<n>`, but tools, `needsApproval`, permission rules and tool-call
 * hooks see the session's own id as `ctx.sessionId` - as they do without a store.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { memoryStore } from '../storage/agentStore';
import { mockModel } from '../testing';

const calling = (name: string, id = `call_${name}`) => ({ toolCalls: [{ name, id, args: {} }] });

function probe(seen: Record<string, unknown>, gate = false) {
  return defineTool({
    name: 'probe',
    description: 'records the session id it sees',
    input: z.object({}),
    needsApproval: (_args, ctx) => {
      seen.needsApproval = ctx.sessionId;
      return gate;
    },
    execute: async (_args, ctx) => {
      seen.execute = ctx.sessionId;
      return 'ok';
    },
  });
}

describe('ctx.sessionId in a checkpointed session (Eve DUI-F5)', () => {
  for (const durable of [false, true]) {
    it(`tools, needsApproval, permission rules and hooks see the session id (${durable ? 'durable' : 'in-memory'})`, async () => {
      const seen: Record<string, unknown> = {};
      const agent = createAgent({
        provider: mockModel([calling('probe'), 'done']),
        tools: [probe(seen)],
        permissions: [{ tool: 'probe', when: (_args, ctx) => ((seen.permission = ctx.sessionId), false), action: 'deny' }],
        hooks: [{ name: 'probe-hook', preToolCall: (ctx) => void (seen.hook = ctx.sessionId) }],
        ...(durable && { store: memoryStore() }),
      });
      await agent.session({ id: 'user-42' }).send('hi');
      expect(seen).toEqual({ needsApproval: 'user-42', execute: 'user-42', permission: 'user-42', hook: 'user-42' });
    });
  }

  it('a tool approved after a pause, and the rest of the resumed turn, see the session id too', async () => {
    const seen: Record<string, unknown> = {};
    const later: unknown[] = [];
    const after = defineTool({ name: 'after', description: 'd', input: z.object({}), execute: async (_a, ctx) => (later.push(ctx.sessionId), 'ok') });
    const store = memoryStore();
    const agent = createAgent({ provider: mockModel([calling('probe'), calling('after'), 'done']), tools: [probe(seen, true), after], store });
    const paused = await agent.session({ id: 'user-42' }).send('hi');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(await store.checkpoints.load('user-42.turn-0')).toMatchObject({ status: 'awaiting-approval' });

    const resolved = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(resolved.text).toBe('done');
    expect(seen.execute).toBe('user-42');
    expect(later).toEqual(['user-42']);
  });
});
