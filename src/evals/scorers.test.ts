import { describe, it, expect } from 'vitest';
import { exactMatch, toolCallOrder } from './scorers';
import { ExecutionResult } from '../execution/AgentExecutor';
import { ToolCall } from '../providers/llm';

function fakeResult(text: string, toolCalls: ToolCall[] = []): ExecutionResult {
  return {
    text,
    messages: [],
    toolCalls,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    finishReason: 'stop',
    steps: 1,
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
