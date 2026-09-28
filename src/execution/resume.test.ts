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

  it('should not duplicate the system message when resuming an agent that has agent.prompt set', async () => {
    const execute = vi.fn().mockResolvedValue({ charged: true });
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute } as any,
      needsApproval: true,
    });

    const systemPrompt = 'You are a careful billing assistant.';
    const agent = AgentBuilder.create()
      .setType(AgentType.SmartAssistant)
      .setName('Test Agent')
      .setPrompt(systemPrompt)
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

    // Sanity check: exactly one system message before the pause too.
    const pausedSystemMessages = paused.messages.filter((m) => m.role === 'system');
    expect(pausedSystemMessages).toHaveLength(1);
    expect(pausedSystemMessages[0].content).toBe(systemPrompt);

    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvalStore,
      toolRegistry,
      provider
    );

    // Regression check for the resume duplicate-system-message bug: after
    // resuming, there must still be exactly ONE system message, matching
    // the original agent.prompt content - not two.
    const resumedSystemMessages = resumed.messages.filter((m) => m.role === 'system');
    expect(resumedSystemMessages).toHaveLength(1);
    expect(resumedSystemMessages[0].content).toBe(systemPrompt);
  });

  it('should resolve (not reject) with an error-shaped tool message when the deferred tool throws on resume', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('payment gateway timeout'));
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

    // Should resolve, not reject, even though the deferred tool throws.
    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvalStore,
      toolRegistry,
      provider
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const toolMessage = resumed.messages[paused.messages.length];
    expect(toolMessage.role).toBe('tool');
    const parsed = JSON.parse(toolMessage.content);
    expect(parsed.error).toBe('payment gateway timeout');
  });

  it('should continue step-count accounting from the pre-pause step count on resume', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
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

    // Scripted provider: two plain (no tool call) generations first, to
    // burn 2 steps, then a generation that triggers the approval-gated
    // tool call, then a final stop response after resume.
    let call = 0;
    const scriptedProvider = {
      name: 'scripted',
      supportsTools: () => true,
      supportsStreaming: () => false,
      getModels: async () => ['scripted'],
      stream: async () => {
        throw new Error('not implemented');
      },
      generate: async () => {
        call++;
        if (call <= 2) {
          return {
            text: `thinking step ${call}`,
            finishReason: 'stop' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        }
        if (call === 3) {
          return {
            text: 'calling chargeCard',
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            toolCalls: [
              {
                id: 'call-1',
                type: 'function' as const,
                function: { name: 'chargeCard', arguments: '{}' },
              },
            ],
          };
        }
        return {
          text: 'done',
          finishReason: 'stop' as const,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    };

    const approvalStore = createInMemoryApprovalStore();

    // Force exactly one step per execute() call so the 2 "thinking" steps
    // are pre-pause history the *next* execute() call must pick up from.
    const firstStep = await AgentExecutor.execute({
      agent,
      input: 'go',
      provider: scriptedProvider as any,
      toolRegistry,
      approvalStore,
      maxSteps: 1,
    });
    expect(firstStep.steps).toBe(1);

    const secondStep = await AgentExecutor.execute({
      agent,
      input: firstStep.messages,
      provider: scriptedProvider as any,
      toolRegistry,
      approvalStore,
      maxSteps: firstStep.steps + 1,
      skipSystemPromptInjection: true,
      initialSteps: firstStep.steps,
    } as any);
    expect(secondStep.steps).toBe(2);

    // Third call actually triggers the approval-gated tool call, continuing
    // from step 2.
    const paused = await AgentExecutor.execute({
      agent,
      input: secondStep.messages,
      provider: scriptedProvider as any,
      toolRegistry,
      approvalStore,
      skipSystemPromptInjection: true,
      initialSteps: secondStep.steps,
    } as any);
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.steps).toBe(3);

    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvalStore,
      toolRegistry,
      scriptedProvider as any
    );

    // Continuation from step 3 (not reset to 0/1): one more generation
    // happens on resume, so steps should be 4.
    expect(resumed.steps).toBe(4);
  });

  it('should throw a clear error for an unknown or already-resolved approval id', async () => {
    const approvalStore = createInMemoryApprovalStore();
    const provider = createMockProvider({ name: 'mock' });

    await expect(
      resumeAfterApproval({ id: 'never-existed', approved: true }, approvalStore, toolRegistry, provider)
    ).rejects.toThrow(/No pending approval/);
  });
});
