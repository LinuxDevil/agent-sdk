import { describe, it, expect } from 'vitest';
import { parseAgentSpecV2 } from './parse';
import { agentSpecV2Schema } from './schema';
import type { AgentSpecV2 } from './types';

const base: AgentSpecV2 = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function spec(overrides: Partial<AgentSpecV2>): AgentSpecV2 {
  return { ...base, ...overrides };
}

function issuesOf(data: unknown) {
  const result = agentSpecV2Schema.safeParse(data);
  return result.success ? [] : result.error.issues;
}

function pathOf(entry: { path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> }): string {
  return (entry.path ?? []).map((part) => (typeof part === 'object' && part !== null ? part.key : part)).join('.');
}

describe('evals', () => {
  it('accepts every gate kind', () => {
    const parsed = parseAgentSpecV2(
      spec({
        evals: [
          {
            dataset: 'support-triage',
            gates: [
              { calledTool: 'search' },
              { notCalledTool: 'delete' },
              { maxCostUsd: 0.05 },
              { maxSteps: 8 },
              { judge: { model: 'openai/gpt-4o-mini', rubric: 'Answers the question.', minScore: 0.7 } },
            ],
            minPassRate: 0.75,
          },
        ],
      })
    );
    expect(parsed.evals).toHaveLength(1);
    expect(parsed.evals?.[0].gates).toHaveLength(5);
  });

  it('accepts an empty evals list and a spec without evals', () => {
    expect(parseAgentSpecV2(spec({ evals: [] })).evals).toEqual([]);
    expect(parseAgentSpecV2(spec({})).evals).toBeUndefined();
  });

  it('rejects a gate with zero or two keys', () => {
    const gates = (gate: unknown) => ({ ...base, evals: [{ dataset: 'd', gates: [gate], minPassRate: 1 }] });
    expect(issuesOf(gates({})).some((issue) => pathOf(issue) === 'evals.0.gates.0')).toBe(true);
    expect(issuesOf(gates({ calledTool: 'x', maxSteps: 3 })).length).toBeGreaterThan(0);
  });

  it('rejects an unknown gate key', () => {
    const issues = issuesOf({ ...base, evals: [{ dataset: 'd', gates: [{ mustPass: true }], minPassRate: 1 }] });
    expect(issues.some((issue) => pathOf(issue) === 'evals.0.gates.0')).toBe(true);
  });

  it('rejects bad gate values at their own paths', () => {
    const entry = (gate: unknown) => ({ ...base, evals: [{ dataset: 'd', gates: [gate], minPassRate: 1 }] });
    expect(issuesOf(entry({ calledTool: '' })).some((issue) => pathOf(issue) === 'evals.0.gates.0.calledTool')).toBe(true);
    expect(issuesOf(entry({ maxCostUsd: -1 })).some((issue) => pathOf(issue) === 'evals.0.gates.0.maxCostUsd')).toBe(true);
    expect(issuesOf(entry({ maxSteps: 2.5 })).some((issue) => pathOf(issue) === 'evals.0.gates.0.maxSteps')).toBe(true);
    expect(
      issuesOf(entry({ judge: { model: 'gpt-4o', rubric: 'r', minScore: 1.5 } })).some(
        (issue) => pathOf(issue) === 'evals.0.gates.0.judge.minScore'
      )
    ).toBe(true);
    expect(
      issuesOf(entry({ judge: { model: 'not a model', rubric: 'r', minScore: 0.5 } })).some(
        (issue) => pathOf(issue) === 'evals.0.gates.0.judge.model'
      )
    ).toBe(true);
  });

  it('rejects a spec-level evals entry missing dataset, gates or minPassRate', () => {
    const missing = (entry: Record<string, unknown>) => ({ ...base, evals: [entry] });
    expect(issuesOf(missing({ gates: [{ maxSteps: 1 }], minPassRate: 1 })).some((i) => pathOf(i) === 'evals.0.dataset')).toBe(true);
    expect(issuesOf(missing({ dataset: 'd', minPassRate: 1 })).some((i) => pathOf(i) === 'evals.0.gates')).toBe(true);
    expect(issuesOf(missing({ dataset: 'd', gates: [{ maxSteps: 1 }] })).some((i) => pathOf(i) === 'evals.0.minPassRate')).toBe(true);
  });

  it('rejects an empty gates list, out-of-range minPassRate and unknown entry keys', () => {
    expect(issuesOf(spec({ evals: [{ dataset: 'd', gates: [], minPassRate: 1 }] })).length).toBeGreaterThan(0);
    expect(issuesOf(spec({ evals: [{ dataset: 'd', gates: [{ maxSteps: 1 }], minPassRate: 1.5 }] })).length).toBeGreaterThan(0);
    expect(
      issuesOf({ ...base, evals: [{ dataset: 'd', gates: [{ maxSteps: 1 }], minPassRate: 1, extra: 1 }] }).length
    ).toBeGreaterThan(0);
  });

  it('rejects more than 20 evals entries', () => {
    const evals = Array.from({ length: 21 }, (_, index) => ({
      dataset: `d${index}`,
      gates: [{ maxSteps: 1 }],
      minPassRate: 1,
    }));
    const issues = issuesOf(spec({ evals }));
    expect(issues.some((issue) => issue.path?.[0] === 'evals')).toBe(true);
  });
});
