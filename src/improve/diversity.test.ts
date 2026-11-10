import { describe, expect, it } from 'vitest';
import { diversity } from './diversity';
import type { Harness } from './types';

const skill = (content: string) => ({ description: 'Use it.', content });

describe('diversity', () => {
  it('counts one harness as fully alike', () => {
    expect(diversity([{ instructions: 'A', skills: {} }])).toEqual({ meanJaccard: 1, distinct: 1 });
  });

  it('counts two harnesses with no lines as alike', () => {
    expect(diversity([{ instructions: '', skills: {} }, { instructions: ' \n', skills: {} }])).toEqual({ meanJaccard: 1, distinct: 2 });
  });

  it('ignores the order skills were added in and line endings', () => {
    const a: Harness = { instructions: 'A\nB', skills: { x: skill('X'), y: skill('Y') } };
    const b: Harness = { instructions: 'A\r\nB', skills: { y: skill('Y'), x: skill('X') } };
    const c: Harness = { instructions: 'A\nB', skills: { y: skill('Y'), x: skill('X') } };
    expect(diversity([a, c])).toEqual({ meanJaccard: 1, distinct: 1 });
    expect(diversity([a, b]).meanJaccard).toBe(1);
  });

  it('gives the mean of every pair, rounded to four places', () => {
    const result = diversity([
      { instructions: 'A\nB', skills: {} },
      { instructions: 'A\nC', skills: {} },
      { instructions: 'D', skills: {} },
    ]);
    expect(result).toEqual({ meanJaccard: 0.1111, distinct: 3 });
  });
});
