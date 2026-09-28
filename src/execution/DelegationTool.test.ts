import { describe, it, expect, vi } from 'vitest';
import { createDelegateTool } from './DelegationTool';
import { AgentType } from '../types';
import type { LLMProvider, GenerateResult } from '../providers';

function makeGenerateResult(text: string): GenerateResult {
  return {
    text,
    finishReason: 'stop',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

function makeMockProvider(generate: LLMProvider['generate']): LLMProvider {
  return {
    name: 'mock',
    generate,
    stream: vi.fn() as any,
    supportsTools: () => true,
    supportsStreaming: () => true,
    getModels: async () => [],
  };
}

describe('createDelegateTool', () => {
  it('invokes the child agent with only the delegated task as input', async () => {
    const generate = vi.fn().mockResolvedValue(makeGenerateResult('child response'));
    const provider = makeMockProvider(generate);

    const childAgent = {
      name: 'Child Agent',
      agentType: AgentType.SmartAssistant,
      prompt: 'You are a helpful child agent',
    };

    const delegateTool = createDelegateTool({
      agent: childAgent,
      provider,
    });

    const result = await delegateTool.tool.execute!({ task: 'Do the thing' }, {} as any);

    expect(generate).toHaveBeenCalledTimes(1);
    const callArgs = generate.mock.calls[0][0];

    // messages should contain the system prompt (from agent.prompt) plus
    // exactly one user message with the delegated task - no unrelated
    // parent conversation history leaking in.
    const userMessages = callArgs.messages.filter((m: any) => m.role === 'user');
    expect(userMessages).toEqual([{ role: 'user', content: 'Do the thing' }]);

    expect(result).toEqual({
      text: 'child response',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
  });

  it('works with an agent that has no system prompt', async () => {
    const generate = vi.fn().mockResolvedValue(makeGenerateResult('ok'));
    const provider = makeMockProvider(generate);

    const childAgent = {
      name: 'Bare Agent',
      agentType: AgentType.SmartAssistant,
    };

    const delegateTool = createDelegateTool({ agent: childAgent, provider });
    await delegateTool.tool.execute!({ task: 'task 1' }, {} as any);

    const callArgs = generate.mock.calls[0][0];
    expect(callArgs.messages).toEqual([{ role: 'user', content: 'task 1' }]);
  });
});
