import { describe, expect, it } from 'vitest';
import { readFixtureTree, readNegativeTree } from '../workspaces/__fixtures__/readTree';
import { validateWorkspace } from '../workspaces/contracts/validate';
import { goalCheck, goalProblems, goalSchema, type GoalSpec } from './contract';

const valid: GoalSpec = { schema: 'lousho.goal/1', goal: 'Find facts.', checks: [{ criterion: 'findings-present' }], stop: { maxIterations: 5, maxCostUsd: 2 } };

const paths = (value: unknown): string[] => {
  const result = goalSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};

describe('goal.json contract', () => {
  it('a goal with a rubric-only check is an error', () => {
    expect(goalProblems(valid, [{ id: 'findings-present', rubric: 'Reads well.' }])).toEqual([expect.objectContaining({ kind: 'no-executable-check' })]);
    expect(goalProblems(valid, [{ id: 'findings-present', check: 'harness/checks/findings-present.ts' }])).toEqual([]);
    const tree = readNegativeTree('goal-rubric-only');
    expect(validateWorkspace(tree)).toEqual([expect.objectContaining({ code: 'PRD033', file: 'pages/main/goal.json', path: 'checks' })]);
  });

  it('a goal without maxCostUsd is an error', () => {
    expect(paths({ ...valid, stop: { maxIterations: 5 } })).toEqual(['stop.maxCostUsd']);
    const tree = { ...readFixtureTree('marketing'), 'pages/content-research/goal.json': { ...valid, stop: { maxIterations: 5 } } };
    expect(validateWorkspace(tree)).toEqual([expect.objectContaining({ code: 'PRD030', file: 'pages/content-research/goal.json', path: 'stop.maxCostUsd' })]);
  });

  it('checks naming a missing criterion are a PRD error in P0.10', () => {
    const tree = { ...readFixtureTree('marketing'), 'pages/content-research/goal.json': { ...valid, checks: [{ criterion: 'no-such-criterion' }] } };
    expect(validateWorkspace(tree)).toEqual([expect.objectContaining({ code: 'PRD016', file: 'pages/content-research/goal.json', path: 'checks.0.criterion' })]);
  });

  it('maxIterations above 50 is an error (A12)', () => {
    expect(paths({ ...valid, stop: { maxIterations: 51, maxCostUsd: 1 } })).toEqual(['stop.maxIterations']);
    expect(paths({ ...valid, stop: { maxIterations: 0, maxCostUsd: 1 } })).toEqual(['stop.maxIterations']);
  });

  it('a goal with no checks is an error', () => {
    expect(paths({ ...valid, checks: [] })).toEqual(['checks']);
  });

  it('an unknown key is an error', () => {
    expect(paths({ ...valid, lead: 'x' })).toHaveLength(1);
  });

  it('the Marketing fixture goals validate', () => {
    const tree = readFixtureTree('marketing');
    expect(goalSchema.safeParse(tree['pages/content-research/goal.json']).success).toBe(true);
    expect(goalSchema.safeParse(tree['pages/instagram-videos/goal.json']).success).toBe(true);
  });

  it('goalCheck is done only when every executable criterion passes', async () => {
    const check = goalCheck(
      { checks: [{ criterion: 'a' }, { criterion: 'b' }, { criterion: 'r' }] },
      {
        a: { evaluate: () => ({ score: 1, passed: true, threshold: 1 }) },
        b: {
          evaluate: (output) => {
            const value = (output as { b?: string }).b;
            return { score: value ? 1 : 0, passed: Boolean(value), threshold: 1, message: 'b missing' };
          },
        },
      }
    );
    const first = await check({ iteration: 1, output: {} });
    expect(first).toEqual({
      done: false,
      score: 0.5,
      reason: 'b: b missing',
      results: [{ criterion: 'a', passed: true, score: 1 }, { criterion: 'b', passed: false, score: 0, message: 'b missing' }, { criterion: 'r' }],
    });
    expect((await check({ iteration: 2, output: { b: 'x' } })).done).toBe(true);
  });

  it('a throwing check counts as failed', async () => {
    const check = goalCheck(
      { checks: [{ criterion: 'boom' }] },
      {
        boom: {
          evaluate: () => {
            throw new TypeError('boom');
          },
        },
      }
    );
    const result = await check({ iteration: 1, output: {} });
    expect(result.results[0]).toEqual({ criterion: 'boom', passed: false, score: 0, message: 'boom' });
    expect(result.done).toBe(false);
  });

  it('no resolved check is never done', async () => {
    const result = await goalCheck({ checks: [{ criterion: 'r' }] }, {})({ iteration: 1, output: {} });
    expect(result).toEqual({ done: false, score: 0, reason: 'all checks pass', results: [{ criterion: 'r' }] });
  });
});
