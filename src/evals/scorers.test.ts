import { describe, it, expect } from 'vitest';
import { exactMatch } from './scorers';
import { ExecutionResult } from '../execution/AgentExecutor';

function fakeResult(text: string): ExecutionResult {
  return {
    text,
    messages: [],
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    finishReason: 'stop',
    steps: 1,
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
