import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { deriveEdges } from '../../edges';
import { graphToSpec } from '../../graphToSpec';
import { duplicateNode } from '../../mutations';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2 } from '../../specTypes';
import type { Graph, GuardrailNodeData, Problem } from '../../types';
import { validateGraph } from '../../validateGraph';

/** The ticket's worked example: a pii rewrite check on both sides, a prompt-injection check in parallel on the input. */
const WORKED = `version: 2
name: support-bot
model: anthropic/claude-sonnet-5-5
instructions: Answer tickets.
guardrails:
  - { id: g1, name: pii, on: [input, output], onTripped: rewrite, options: { action: rewrite, types: [email, phone] } }
  - { id: g2, name: prompt-injection, on: input, runInParallel: true }
`;

const WORKED_IDS = ['agent', 'guard:g1', 'guard:g2'];

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(guardrails: Record<string, unknown>[], over: Record<string, unknown> = {}): Graph {
  return specToGraph(specOf({ guardrails, ...over }));
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return { nodeId, severity: 'error', message, fieldPath };
}

describe('specToGraph: guardrail worked example', () => {
  const graph = specToGraph(parse(WORKED) as AgentSpecV2);

  it('produces the two guard nodes with the listed ids, in order', () => {
    expect(graph.nodes.map((n) => n.id)).toEqual(WORKED_IDS);
  });

  it('keeps each entry as { item }, owned by the root agent', () => {
    const spec = parse(WORKED) as AgentSpecV2;
    const entries = spec.guardrails ?? [];
    for (const [i, node] of graph.nodes.slice(1).entries()) {
      expect(node.owner).toBe('agent');
      expect(node.kind).toBe('guardrail');
      expect((node.data as GuardrailNodeData).item).toStrictEqual(entries[i]);
    }
  });

  it('draws the two guards edges', () => {
    const ids = deriveEdges(graph).map((e) => e.id);
    expect(ids).toContain('guards:agent->guard:g1');
    expect(ids).toContain('guards:agent->guard:g2');
  });

  it('round-trips to an identical spec', () => {
    const spec = parse(WORKED) as AgentSpecV2;
    expect(graphToSpec(specToGraph(spec)).spec).toStrictEqual(spec);
  });
});

describe('guardrailRules.validate', () => {
  it('requires a picked guardrail', () => {
    const g = graphOf([{ id: 'g1', name: '' }]);
    expect(validateGraph(g)).toStrictEqual([
      error('guard:g1', 'Pick a guardrail', 'guardrails[0].name'),
    ]);
  });

  it.each(['bad id', '-dash', 'x'.repeat(65)])('flags an id outside the spec pattern (%j)', (id) => {
    const g = specToGraph(specOf({ guardrails: [{ id, name: 'max-length' }] }));
    const nodeId = g.nodes.find((n) => n.kind === 'guardrail')!.id;
    expect(validateGraph(g)).toStrictEqual([
      error(nodeId, 'The id can use letters, digits, dot, dash or underscore', 'guardrails[0].id'),
    ]);
  });

  it.each([
    ['llm-judge', 'model', {}],
    ['moderation', 'model', {}],
    ['regex', 'pattern', {}],
    ['deny-topics', 'topics', {}],
    ['llm-judge', 'model', { model: '' }],
    ['deny-topics', 'topics', { topics: [] }],
  ] as const)('requires the %s option %s (options %j)', (name, option, options) => {
    const g = graphOf([{ id: 'g1', name, options }]);
    expect(validateGraph(g)).toStrictEqual([
      error('guard:g1', `This guardrail needs the '${option}' option`, `guardrails[0].options.${option}`),
    ]);
  });

  it('refuses runInParallel on a guardrail that cannot run in parallel', () => {
    const g = graphOf([{ id: 'g1', name: 'pii', on: 'input', runInParallel: true }]);
    expect(validateGraph(g)).toStrictEqual([
      error(
        'guard:g1',
        'Only prompt-injection and moderation can run in parallel, on input',
        'guardrails[0].runInParallel',
      ),
    ]);
  });

  it('refuses runInParallel on the output side', () => {
    const g = graphOf([{ id: 'g1', name: 'moderation', on: 'output', runInParallel: true, options: { model: 'm' } }]);
    expect(validateGraph(g)).toStrictEqual([
      error(
        'guard:g1',
        'Only prompt-injection and moderation can run in parallel, on input',
        'guardrails[0].runInParallel',
      ),
    ]);
  });

  it('refuses a parallel check that rewrites', () => {
    const g = graphOf([
      { id: 'g1', name: 'prompt-injection', on: 'input', runInParallel: true, onTripped: 'rewrite' },
    ]);
    expect(validateGraph(g)).toStrictEqual([
      // prompt-injection cannot rewrite at all, and a parallel check cannot rewrite either.
      error('guard:g1', "'prompt-injection' cannot rewrite; use 'block'", 'guardrails[0].onTripped'),
      error('guard:g1', 'A parallel check cannot rewrite', 'guardrails[0].onTripped'),
    ]);
  });

  it('refuses a parallel check whose options.action rewrites', () => {
    const g = graphOf([
      { id: 'g1', name: 'prompt-injection', on: 'input', runInParallel: true, options: { action: 'rewrite' } },
    ]);
    expect(validateGraph(g)).toStrictEqual([
      error('guard:g1', 'A parallel check cannot rewrite', 'guardrails[0].options.action'),
    ]);
  });

  it('refuses onTripped warn (the SDK has no warn mechanism)', () => {
    const g = graphOf([{ id: 'g1', name: 'max-length', onTripped: 'warn' }]);
    expect(validateGraph(g)).toStrictEqual([
      error('guard:g1', "'warn' is not supported; use 'block' or 'rewrite'", 'guardrails[0].onTripped'),
    ]);
  });

  it('refuses rewrite on a built-in that cannot rewrite', () => {
    const g = graphOf([{ id: 'g1', name: 'max-length', onTripped: 'rewrite' }]);
    expect(validateGraph(g)).toStrictEqual([
      error('guard:g1', "'max-length' cannot rewrite; use 'block'", 'guardrails[0].onTripped'),
    ]);
  });

  it('refuses onTripped and options.action disagreeing', () => {
    const g = graphOf([{ id: 'g1', name: 'pii', onTripped: 'block', options: { action: 'rewrite' } }]);
    expect(validateGraph(g)).toStrictEqual([
      error('guard:g1', 'set either onTripped or options.action, not both', 'guardrails[0].options.action'),
    ]);
  });

  it('refuses a regex pattern that does not compile', () => {
    const g = graphOf([{ id: 'g1', name: 'regex', options: { pattern: '[' } }]);
    expect(validateGraph(g)).toStrictEqual([
      error('guard:g1', 'The pattern is not a valid regular expression', 'guardrails[0].options.pattern'),
    ]);
  });

  it('accepts a valid spec with no problems', () => {
    const g = specToGraph(parse(WORKED) as AgentSpecV2);
    expect(validateGraph(g)).toStrictEqual([]);
  });

  it('maps problems to the nested spec path inside an inline agent', () => {
    const g = specToGraph(
      specOf({
        subagents: {
          r: {
            inline: {
              name: 'r',
              description: 'd',
              model: 'mock/mock-1',
              instructions: 'x',
              guardrails: [{ id: 'g1', name: 'regex', options: { pattern: '[' } }],
            },
          },
        },
      }),
    );
    expect(validateGraph(g)).toStrictEqual([
      error(
        'sub:r/guard:g1',
        'The pattern is not a valid regular expression',
        'subagents.r.inline.guardrails[0].options.pattern',
      ),
    ]);
  });
});

describe('guardrailRules.duplicateData', () => {
  it('gives the copy the next free g id', () => {
    const g = graphOf([
      { id: 'g1', name: 'pii' },
      { id: 'g2', name: 'prompt-injection' },
    ]);
    const result = duplicateNode(g, 'guard:g1');
    expect(result.nodeId).toBe('guard:g3');
    const copy = result.graph.nodes.find((n) => n.id === 'guard:g3')!;
    expect((copy.data as GuardrailNodeData).item).toStrictEqual({ id: 'g3', name: 'pii' });
  });
});
