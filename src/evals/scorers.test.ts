import { describe, it, expect } from 'vitest';
import { exactMatch, toolCallOrder, budget, describeBudgetFailure } from './scorers';
import { AgentExecutor, ExecutionResult } from '../execution/AgentExecutor';
import { ToolCall, LLMProvider, GenerateOptions, GenerateResult } from '../providers/llm';
import { ToolRegistry } from '../tools';
import { AgentBuilder } from '../core';
import { AgentType } from '../types';

function fakeResult(
  text: string,
  toolCalls: ToolCall[] = [],
  overrides: Partial<Pick<ExecutionResult, 'usage' | 'steps'>> = {}
): ExecutionResult {
  return {
    text,
    messages: [],
    toolCalls,
    usage: overrides.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    finishReason: 'stop',
    steps: overrides.steps ?? 1,
  };
}

function fakeToolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

describe('exactMatch', () => {
  it('scores 1 on exact string match, 0 on mismatch', () => {
    const scorer = exactMatch('hello world');
    expect(scorer(fakeResult('hello world'))).toBe(1);
    expect(scorer(fakeResult('goodbye world'))).toBe(0);
  });

  it('scores 1 when a RegExp matches, 0 when it does not', () => {
    const scorer = exactMatch(/^\d+ items$/);
    expect(scorer(fakeResult('42 items'))).toBe(1);
    expect(scorer(fakeResult('forty-two items'))).toBe(0);
  });

  it('scores 1/0 based on a predicate function, without throwing for a predicate that throws', () => {
    const scorer = exactMatch((text: string) => text.includes('success'));
    expect(scorer(fakeResult('operation success'))).toBe(1);
    expect(scorer(fakeResult('operation failed'))).toBe(0);

    const throwingScorer = exactMatch(() => {
      throw new Error('predicate blew up');
    });
    expect(() => throwingScorer(fakeResult('anything'))).not.toThrow();
    expect(throwingScorer(fakeResult('anything'))).toBe(0);
  });
});

describe('toolCallOrder', () => {
  const searchCall = fakeToolCall('call_1', 'search', { query: 'cats' });
  const summarizeCall = fakeToolCall('call_2', 'summarize', { maxWords: 50 });

  it('scores 1 for an exact-order, exact-args match', () => {
    const scorer = toolCallOrder([
      { tool: 'search', args: { query: 'cats' } },
      { tool: 'summarize', args: { maxWords: 50 } },
    ]);
    expect(scorer(fakeResult('done', [searchCall, summarizeCall]))).toBe(1);
  });

  it('scores 0 for a shuffled order', () => {
    const scorer = toolCallOrder([
      { tool: 'search', args: { query: 'cats' } },
      { tool: 'summarize', args: { maxWords: 50 } },
    ]);
    expect(scorer(fakeResult('done', [summarizeCall, searchCall]))).toBe(0);
  });

  it('scores 0 for a missing call (length mismatch)', () => {
    const scorer = toolCallOrder([
      { tool: 'search', args: { query: 'cats' } },
      { tool: 'summarize', args: { maxWords: 50 } },
    ]);
    expect(scorer(fakeResult('done', [searchCall]))).toBe(0);
  });

  it('scores 0 on args mismatch even when tool names and order match', () => {
    const scorer = toolCallOrder([{ tool: 'search', args: { query: 'dogs' } }]);
    expect(scorer(fakeResult('done', [searchCall]))).toBe(0);
  });

  it('ignores args entirely when not specified in the expected call', () => {
    const scorer = toolCallOrder([{ tool: 'search' }]);
    expect(scorer(fakeResult('done', [searchCall]))).toBe(1);
  });
});

describe('budget', () => {
  it('scores 1 at 50% of the budget', () => {
    const scorer = budget({ maxTokens: 1000, maxSteps: 10 });
    const result = fakeResult('done', [], {
      usage: { promptTokens: 300, completionTokens: 200, totalTokens: 500 },
      steps: 5,
    });
    expect(scorer(result)).toBe(1);
  });

  it('scores 0 at 150% of the budget', () => {
    const scorer = budget({ maxTokens: 1000, maxSteps: 10 });
    const result = fakeResult('done', [], {
      usage: { promptTokens: 900, completionTokens: 600, totalTokens: 1500 },
      steps: 15,
    });
    expect(scorer(result)).toBe(0);
  });
});

describe('toolCallOrder() against a genuine AgentExecutor.execute() result', () => {
  // LOU-G4's acceptance criteria requires toolCallOrder() to be verified
  // against REAL AgentExecutor.execute() output, not just fakeResult()/
  // fakeToolCall() fixtures - a scorer can type-check against the
  // ExecutionResult/ToolCall shapes while silently drifting from how the
  // real executor actually populates `toolCalls` (field naming, whether
  // `arguments` is a JSON string vs. object, ordering guarantees, etc.).
  // This runs a real agent loop with two real tools registered in a real
  // ToolRegistry, driven by a scripted LLMProvider (the same
  // "scripted provider" pattern AgentExecutor.test.ts uses for multi-step
  // tool-calling tests), and feeds the genuine result.toolCalls into
  // toolCallOrder().

  it('scores 1 for the correct order and 0 for a wrong order, on a real execute() result', async () => {
    const toolRegistry = new ToolRegistry();

    const searchExecute = async (args: Record<string, unknown>) => ({ found: args.query });
    const summarizeExecute = async (args: Record<string, unknown>) => ({
      summary: `summary of ${args.maxWords} words`,
    });

    toolRegistry.register('search', {
      displayName: 'Search',
      tool: {
        description: 'Searches for something',
        parameters: {},
        execute: searchExecute,
      } as any,
    });
    toolRegistry.register('summarize', {
      displayName: 'Summarize',
      tool: {
        description: 'Summarizes something',
        parameters: {},
        execute: summarizeExecute,
      } as any,
    });

    const agent = AgentBuilder.create()
      .setType(AgentType.SmartAssistant)
      .setName('Test Agent')
      .addTool('search', { tool: 'search', options: {} })
      .addTool('summarize', { tool: 'summarize', options: {} })
      .build();

    // Scripted provider: on step 1 requests `search`, on step 2 requests
    // `summarize`, then stops - mirroring the scripted-provider pattern
    // used by AgentExecutor.test.ts (a plain object implementing
    // LLMProvider with a generate() that counts calls and returns
    // different ToolCall[] per step).
    let call = 0;
    const scriptedProvider: LLMProvider = {
      name: 'scripted',
      supportsTools: () => true,
      supportsStreaming: () => false,
      getModels: async () => ['scripted'],
      stream: async () => {
        throw new Error('not implemented');
      },
      generate: async (_options: GenerateOptions): Promise<GenerateResult> => {
        call++;
        if (call === 1) {
          return {
            text: '',
            finishReason: 'tool_calls',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            toolCalls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'search', arguments: JSON.stringify({ query: 'cats' }) },
              },
            ],
          };
        }
        if (call === 2) {
          return {
            text: '',
            finishReason: 'tool_calls',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            toolCalls: [
              {
                id: 'call-2',
                type: 'function',
                function: { name: 'summarize', arguments: JSON.stringify({ maxWords: 50 }) },
              },
            ],
          };
        }
        return {
          text: 'done',
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    };

    // A genuine AgentExecutor.execute() call - not a stub, not a mock of
    // execute() itself. Only the LLMProvider is scripted; the executor's
    // own tool-calling loop, message building and toolCalls accumulation
    // all run for real.
    const result = await AgentExecutor.execute({
      agent,
      input: 'search then summarize',
      provider: scriptedProvider,
      toolRegistry,
    });

    // Sanity: the real executor really did call both tools, in order, and
    // really did populate `arguments` as a JSON string (not an object) -
    // exactly the drift risk this test exists to catch.
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].function.name).toBe('search');
    expect(result.toolCalls[1].function.name).toBe('summarize');
    expect(typeof result.toolCalls[0].function.arguments).toBe('string');

    const correctScorer = toolCallOrder([
      { tool: 'search', args: { query: 'cats' } },
      { tool: 'summarize', args: { maxWords: 50 } },
    ]);
    expect(correctScorer(result)).toBe(1);

    const reversedScorer = toolCallOrder([
      { tool: 'summarize', args: { maxWords: 50 } },
      { tool: 'search', args: { query: 'cats' } },
    ]);
    expect(reversedScorer(result)).toBe(0);

    const missingCallScorer = toolCallOrder([{ tool: 'search', args: { query: 'cats' } }]);
    expect(missingCallScorer(result)).toBe(0);
  });
});

describe('describeBudgetFailure', () => {
  it('includes both the actual and budgeted numbers as substrings', () => {
    const limits = { maxTokens: 1000, maxSteps: 10 };
    const result = fakeResult('done', [], {
      usage: { promptTokens: 900, completionTokens: 600, totalTokens: 1500 },
      steps: 15,
    });
    const message = describeBudgetFailure(result, limits);

    expect(message).toContain('1500');
    expect(message).toContain('1000');
    expect(message).toContain('15');
    expect(message).toContain('10');
  });
});
