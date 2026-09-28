import { describe, it, expect } from 'vitest';
import { ExecutionSnapshot } from './ApprovalGate';
import { AgentType } from '../types';

describe('Execution - ApprovalGate types', () => {
  it('should round-trip an ExecutionSnapshot through JSON with no loss', () => {
    const snapshot: ExecutionSnapshot = {
      agent: {
        id: 'agent-1',
        name: 'Test Agent',
        agentType: AgentType.SmartAssistant,
        prompt: 'You are a helpful assistant',
      },
      currentMessages: [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Please charge the card' },
      ],
      pendingToolCall: {
        id: 'approval-1',
        toolCallId: 'call-1',
        toolName: 'chargeCard',
        args: { amount: 500 },
        agentId: 'agent-1',
        createdAt: new Date().toISOString(),
      },
      steps: 1,
    };

    const roundTripped = JSON.parse(JSON.stringify(snapshot)) as ExecutionSnapshot;

    expect(roundTripped).toEqual(snapshot);
  });
});
