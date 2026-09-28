import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as resumeModule from '../../src/execution/resume';
import {
  extractApprovalIdFromInteraction,
  handleSlackInteraction,
  createInMemoryApprovalStore,
  SlackInteractionPayload,
} from './slackInteractions';
import { ApprovalStore, ExecutionSnapshot, PendingApproval } from '../../src/execution/ApprovalGate';
import { ToolRegistry } from '../../src/tools';
import { createMockProvider } from '../../src/providers/mock';
import { AgentType } from '../../src/types';

describe('extractApprovalIdFromInteraction', () => {
  it('extracts the approvalId from a fix_it block_actions click', () => {
    const payload: SlackInteractionPayload = {
      type: 'block_actions',
      actions: [{ action_id: 'fix_it', value: 'approval-abc' }],
    };
    expect(extractApprovalIdFromInteraction(payload)).toBe('approval-abc');
  });

  it('returns undefined for a non-fix_it action', () => {
    const payload: SlackInteractionPayload = {
      type: 'block_actions',
      actions: [{ action_id: 'something_else', value: 'x' }],
    };
    expect(extractApprovalIdFromInteraction(payload)).toBeUndefined();
  });

  it('returns undefined for a non-block_actions payload', () => {
    expect(extractApprovalIdFromInteraction({ type: 'view_submission' })).toBeUndefined();
  });
});

describe('handleSlackInteraction routes to the REAL resumeAfterApproval', () => {
  let approvalStore: ApprovalStore;
  let toolRegistry: ToolRegistry;
  const provider = createMockProvider({ responses: ['done'] });

  beforeEach(() => {
    approvalStore = createInMemoryApprovalStore();
    toolRegistry = new ToolRegistry();
  });

  it('calls resumeAfterApproval exactly once with the matching id, and it actually resolves the pending approval', async () => {
    const resumeSpy = vi.spyOn(resumeModule, 'resumeAfterApproval');

    const execute = vi.fn().mockResolvedValue({ fixed: true });
    toolRegistry.register('apply_fix', {
      displayName: 'Apply Fix',
      tool: { description: 'apply fix', parameters: {}, execute } as any,
      needsApproval: true,
    });

    const pending: PendingApproval = {
      id: 'approval-abc',
      toolCallId: 'call-1',
      toolName: 'apply_fix',
      args: {},
      createdAt: new Date().toISOString(),
    };
    const snapshot: ExecutionSnapshot = {
      agent: { name: 'fixer', agentType: AgentType.SmartAssistant, prompt: 'fix it' },
      currentMessages: [],
      pendingToolCall: pending,
      steps: 1,
    };
    await approvalStore.save(pending, snapshot);

    const payload: SlackInteractionPayload = {
      type: 'block_actions',
      actions: [{ action_id: 'fix_it', value: 'approval-abc' }],
    };

    const result = await handleSlackInteraction(payload, { approvalStore, toolRegistry, provider });

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy.mock.calls[0][0]).toEqual({ id: 'approval-abc', approved: true });
    expect(execute).toHaveBeenCalledTimes(1); // the deferred tool actually ran
    expect(result).toBeDefined();

    resumeSpy.mockRestore();
  });

  it('does not call resumeAfterApproval for a non-fix_it payload', async () => {
    const resumeSpy = vi.spyOn(resumeModule, 'resumeAfterApproval');

    const payload: SlackInteractionPayload = { type: 'view_submission' };
    const result = await handleSlackInteraction(payload, { approvalStore, toolRegistry, provider });

    expect(resumeSpy).not.toHaveBeenCalled();
    expect(result).toBeUndefined();

    resumeSpy.mockRestore();
  });
});
