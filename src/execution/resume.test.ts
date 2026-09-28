import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resumeAfterApproval } from './resume';
import { ApprovalStore, PendingApproval, ExecutionSnapshot } from './ApprovalGate';
import { AgentExecutor } from './AgentExecutor';
import { createMockProvider } from '../providers/mock';
import { ToolRegistry } from '../tools';
import { AgentBuilder } from '../core';
import { AgentType } from '../types';

/** Simple in-memory ApprovalStore, good enough for resume tests. */
function createInMemoryApprovalStore(): ApprovalStore {
  const records = new Map<string, { pending: PendingApproval; snapshot: ExecutionSnapshot }>();
  return {
    async save(pending, snapshot) {
      records.set(pending.id, { pending, snapshot });
    },
    async resolve(id) {
      const record = records.get(id);
      if (!record) {
        return null;
      }
      records.delete(id);
      return record;
    },
  };
}

describe('Execution - resumeAfterApproval', () => {
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
  });

  it('should run the deferred tool exactly once when approved', async () => {
    const execute = vi.fn().mockResolvedValue({ charged: true });
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute } as any,
      needsApproval: true,
    });

    const agent = AgentBuilder.create()
      .setType(AgentType.SmartAssistant)
      .setName('Test Agent')
      .addTool('chargeCard', { tool: 'chargeCard', options: {} })
      .build();

    const provider = createMockProvider({
      name: 'mock',
      responses: ['Charging now', 'All done'],
    });

    const approvalStore = createInMemoryApprovalStore();

    const paused = await AgentExecutor.execute({
      agent,
      input: 'Please call chargeCard now',
      provider,
      toolRegistry,
      approvalStore,
    });

    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.approvalId).toBeDefined();
    expect(execute).not.toHaveBeenCalled();

    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvalStore,
      toolRegistry,
      provider
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(resumed.finishReason).toBe('stop');
    // pre-pause history (user + assistant) + 1 new tool-result message
    expect(resumed.messages).toHaveLength(paused.messages.length + 1);
    expect(resumed.messages.slice(0, paused.messages.length)).toEqual(paused.messages);
    expect(resumed.messages[resumed.messages.length - 1].role).toBe('tool');
  });

  it('should never invoke the tool and should produce a rejection message when rejected', async () => {
    const execute = vi.fn().mockResolvedValue({ charged: true });
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute } as any,
      needsApproval: true,
    });

    const agent = AgentBuilder.create()
      .setType(AgentType.SmartAssistant)
      .setName('Test Agent')
      .addTool('chargeCard', { tool: 'chargeCard', options: {} })
      .build();

    const provider = createMockProvider({
      name: 'mock',
      responses: ['Charging now', 'Understood, cancelled'],
    });

    const approvalStore = createInMemoryApprovalStore();

    const paused = await AgentExecutor.execute({
      agent,
      input: 'Please call chargeCard now',
      provider,
      toolRegistry,
      approvalStore,
    });

    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: false, note: 'Not authorized' },
      approvalStore,
      toolRegistry,
      provider
    );

    expect(execute).not.toHaveBeenCalled();
    const rejectionMessage = resumed.messages[paused.messages.length];
    expect(rejectionMessage.role).toBe('tool');
    const parsed = JSON.parse(rejectionMessage.content);
    expect(parsed.note).toBe('Not authorized');
  });

  it('should throw a clear error for an unknown or already-resolved approval id', async () => {
    const approvalStore = createInMemoryApprovalStore();
    const provider = createMockProvider({ name: 'mock' });

    await expect(
      resumeAfterApproval({ id: 'never-existed', approved: true }, approvalStore, toolRegistry, provider)
    ).rejects.toThrow(/No pending approval/);
  });
});
