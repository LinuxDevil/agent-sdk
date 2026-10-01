import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDelegateTool, DelegationDepthExceededError } from './DelegationTool';
import { AgentExecutor } from './AgentExecutor';
import { AgentType } from '../types';
import { ToolRegistry } from '../tools';
import type { LLMProvider } from '../providers';
import { mockModel } from '../testing';

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
    const provider = mockModel([{ text: 'child response', usage: { inputTokens: 1, outputTokens: 1 } }]);

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

    expect(provider.calls).toHaveLength(1);
    const callArgs = provider.calls[0];

    // messages should contain the system prompt (from agent.prompt) plus
    // exactly one user message with the delegated task - no unrelated
    // parent conversation history leaking in.
    const userMessages = callArgs.messages.filter((m) => m.role === 'user');
    expect(userMessages).toEqual([{ role: 'user', content: 'Do the thing' }]);

    expect(result).toEqual({
      text: 'child response',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
  });

  it('works with an agent that has no system prompt', async () => {
    const provider = mockModel(['ok']);

    const childAgent = {
      name: 'Bare Agent',
      agentType: AgentType.SmartAssistant,
    };

    const delegateTool = createDelegateTool({ agent: childAgent, provider });
    await delegateTool.tool.execute!({ task: 'task 1' }, {} as any);

    expect(provider.calls[0].messages).toEqual([{ role: 'user', content: 'task 1' }]);
  });

  describe('contextMode: full-history', () => {
    it('passes context history then the task message, in order', async () => {
      const provider = mockModel(['done']);

      const agent = { name: 'Contextual Agent', agentType: AgentType.SmartAssistant };
      const delegateTool = createDelegateTool({ agent, provider, contextMode: 'full-history' });

      const context = [
        { role: 'user' as const, content: 'earlier question' },
        { role: 'assistant' as const, content: 'earlier answer' },
      ];

      await delegateTool.tool.execute!({ task: 'follow-up task', context }, {} as any);

      expect(provider.calls[0].messages).toEqual([
        ...context,
        { role: 'user', content: 'follow-up task' },
      ]);
    });

    it('falls back to task-only input when contextMode is the default "none"', async () => {
      const provider = mockModel(['done']);

      const agent = { name: 'Contextual Agent', agentType: AgentType.SmartAssistant };
      const delegateTool = createDelegateTool({ agent, provider });

      const context = [{ role: 'user' as const, content: 'earlier question' }];
      await delegateTool.tool.execute!({ task: 'follow-up task', context }, {} as any);

      expect(provider.calls[0].messages).toEqual([{ role: 'user', content: 'follow-up task' }]);
    });
  });

  describe('maxDepth guard', () => {
    // NOTE on how these tests are structured: AgentExecutor.executeToolCall
    // deliberately catches every error thrown by a tool's execute() and
    // converts it into a `{ error: message }` tool-result message (so the
    // calling LLM can react to a failed tool call conversationally) rather
    // than rethrowing it (see AgentExecutor.ts, established in LOU-C). That
    // means a DelegationDepthExceededError thrown several hops deep inside
    // a *real*, fully LLM-driven A -> B -> A chain would be swallowed
    // by the nearest enclosing AgentExecutor.execute() and would never
    // reach the outermost caller as a rejected promise - even though the
    // depth guard has still done its job and stopped the recursion (the
    // chain terminates gracefully, bounded by each level's own maxSteps,
    // rather than growing the call stack unboundedly).
    //
    // To directly unit-test the depth-tracking/guard logic itself (which is
    // this ticket's actual subject) independent of that swallowing
    // behavior, these tests stub out AgentExecutor.execute so that a
    // "child agent" immediately re-delegates by calling the *other* delegate
    // tool's execute() function directly, in the same way AgentExecutor's
    // real dispatch loop would - but without the try/catch that would
    // otherwise absorb the thrown error. This still exercises the real
    // AsyncLocalStorage-based depth propagation in DelegationTool.ts.
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('propagates depth across an A -> B -> A chain and throws once maxDepth is exceeded', async () => {
      const provider = makeMockProvider(vi.fn());
      const agentA = { name: 'Agent A', agentType: AgentType.SmartAssistant };
      const agentB = { name: 'Agent B', agentType: AgentType.SmartAssistant };

      const delegateToB = createDelegateTool({ agent: agentB, provider, maxDepth: 2 });
      const delegateToA = createDelegateTool({ agent: agentA, provider, maxDepth: 2 });

      vi.spyOn(AgentExecutor, 'execute').mockImplementation(async (options) => {
        if (options.agent === agentA) {
          const r = await delegateToB.tool.execute!({ task: 'to B' }, {} as any);
          return { text: r.text, messages: [], toolCalls: [], usage: r.usage, finishReason: 'stop', steps: 1 };
        }
        if (options.agent === agentB) {
          const r = await delegateToA.tool.execute!({ task: 'to A' }, {} as any);
          return { text: r.text, messages: [], toolCalls: [], usage: r.usage, finishReason: 'stop', steps: 1 };
        }
        throw new Error('unexpected agent in test stub');
      });

      // A delegates to B (depth 0 -> 1), B delegates back to A (depth 1 ->
      // 2), A tries to delegate to B again but depth (2) >= maxDepth (2).
      await expect(delegateToB.tool.execute!({ task: 'start' }, {} as any)).rejects.toThrow(
        DelegationDepthExceededError
      );
    });

    it('succeeds when a delegation chain is exactly maxDepth hops long', async () => {
      const provider = makeMockProvider(vi.fn());
      const agent = { name: 'Recursive Agent', agentType: AgentType.SmartAssistant };
      const maxDepth = 2;
      const totalHops = maxDepth;

      const delegateTool = createDelegateTool({ agent, provider, maxDepth });

      let callCount = 0;
      vi.spyOn(AgentExecutor, 'execute').mockImplementation(async () => {
        callCount++;
        if (callCount < totalHops) {
          const r = await delegateTool.tool.execute!({ task: `hop ${callCount}` }, {} as any);
          return { text: r.text, messages: [], toolCalls: [], usage: r.usage, finishReason: 'stop', steps: 1 };
        }
        return {
          text: 'done',
          messages: [],
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: 'stop',
          steps: 1,
        };
      });

      await expect(delegateTool.tool.execute!({ task: 'start' }, {} as any)).resolves.toEqual(
        expect.objectContaining({ text: 'done' })
      );
    });

    it('fails when a delegation chain goes one hop beyond maxDepth', async () => {
      const provider = makeMockProvider(vi.fn());
      const agent = { name: 'Recursive Agent', agentType: AgentType.SmartAssistant };
      const maxDepth = 2;
      const totalHops = maxDepth + 1;

      const delegateTool = createDelegateTool({ agent, provider, maxDepth });

      let callCount = 0;
      vi.spyOn(AgentExecutor, 'execute').mockImplementation(async () => {
        callCount++;
        if (callCount < totalHops) {
          const r = await delegateTool.tool.execute!({ task: `hop ${callCount}` }, {} as any);
          return { text: r.text, messages: [], toolCalls: [], usage: r.usage, finishReason: 'stop', steps: 1 };
        }
        return {
          text: 'done',
          messages: [],
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: 'stop',
          steps: 1,
        };
      });

      await expect(delegateTool.tool.execute!({ task: 'start' }, {} as any)).rejects.toThrow(
        DelegationDepthExceededError
      );
    });

    it('defaults maxDepth to 3 when omitted', async () => {
      const provider = makeMockProvider(vi.fn());
      const agent = { name: 'Recursive Agent', agentType: AgentType.SmartAssistant };
      const delegateTool = createDelegateTool({ agent, provider });

      let callCount = 0;
      const totalHops = 5; // well beyond the default maxDepth of 3
      vi.spyOn(AgentExecutor, 'execute').mockImplementation(async () => {
        callCount++;
        if (callCount < totalHops) {
          const r = await delegateTool.tool.execute!({ task: `hop ${callCount}` }, {} as any);
          return { text: r.text, messages: [], toolCalls: [], usage: r.usage, finishReason: 'stop', steps: 1 };
        }
        return {
          text: 'done',
          messages: [],
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: 'stop',
          steps: 1,
        };
      });

      await expect(delegateTool.tool.execute!({ task: 'start' }, {} as any)).rejects.toThrow(
        DelegationDepthExceededError
      );
    });

    // LOU-D regression test: unlike the tests above (which stub out
    // AgentExecutor.execute to unit-test depth tracking in isolation), this
    // one drives a *real* A <-> B delegation loop through the real
    // AgentExecutor.execute() + createDelegateTool() dispatch path, with
    // mock LLM providers that unconditionally request delegation to the
    // other agent, forever. This is QA's exact reproduction scenario: it
    // caught a bug the stubbed tests above could not, because
    // executeToolCall's catch-all was silently converting
    // DelegationDepthExceededError into a `{error}` tool-result message fed
    // back to the LLM, which triggered another delegation attempt instead
    // of terminating the run - causing O(maxSteps^maxDepth) LLM calls
    // instead of a bounded, fast failure.
    it('bounds total LLM calls and rejects the top-level execute() when A and B loop forever delegating to each other', async () => {
      const maxDepth = 2;
      const maxSteps = 5;

      // Always requests delegation to the other agent - never stops on its
      // own. Exactly the "neither agent ever stops" pathological case from
      // the bug report.
      const delegating = (task: string) => ({
        toolCalls: [{ name: 'delegate', args: { task } }],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const providerA = mockModel([delegating('go to B')], { onExhausted: 'repeat-last' });
      const providerB = mockModel([delegating('go to A')], { onExhausted: 'repeat-last' });

      const agentA = { name: 'Agent A', agentType: AgentType.SmartAssistant, tools: { delegate: { tool: 'delegate' } } };
      const agentB = { name: 'Agent B', agentType: AgentType.SmartAssistant, tools: { delegate: { tool: 'delegate' } } };

      const registryA = new ToolRegistry();
      const registryB = new ToolRegistry();

      // A's "delegate" tool hands off to B (running through registryB /
      // providerB), and B's "delegate" tool hands off back to A - a genuine
      // A -> B -> A -> ... cycle, each side wired with real
      // AgentExecutor.execute() underneath (createDelegateTool does not
      // stub anything).
      const delegateToBFromA = createDelegateTool({
        agent: agentB,
        provider: providerB,
        toolRegistry: registryB,
        maxDepth,
        maxSteps,
      });
      const delegateToAFromB = createDelegateTool({
        agent: agentA,
        provider: providerA,
        toolRegistry: registryA,
        maxDepth,
        maxSteps,
      });

      registryA.register('delegate', delegateToBFromA);
      registryB.register('delegate', delegateToAFromB);

      const execution = AgentExecutor.execute({
        agent: agentA,
        input: 'start the loop',
        provider: providerA,
        toolRegistry: registryA,
        maxSteps,
      });

      // (a) the top-level execute() call must reject with a clear
      // depth-exceeded signal, not resolve with a normal-looking
      // finishReason: 'tool-calls' result.
      await expect(execution).rejects.toThrow(DelegationDepthExceededError);

      // (b) total LLM calls across the whole run must stay small/bounded -
      // roughly proportional to maxDepth, not maxSteps^maxDepth. Before the
      // fix, QA measured 155 calls for maxDepth=2/maxSteps=5 (and 780 for
      // maxDepth=3/maxSteps=5); after the fix this should be a handful of
      // calls (one per hop until the guard fires), well under 20.
      const totalCalls = providerA.calls.length + providerB.calls.length;
      expect(totalCalls).toBeLessThan(20);
    });
  });
});
