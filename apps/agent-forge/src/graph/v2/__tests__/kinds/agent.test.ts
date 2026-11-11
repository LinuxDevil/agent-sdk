import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { graphToSpec } from '../../graphToSpec';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2 } from '../../specTypes';
import type { Problem } from '../../types';
import { validateGraph } from '../../validateGraph';

/** The ticket's worked example: every form-edited field plus `evals` (an `extra` key). */
const WORKED = `version: 2
name: support-triage
description: Sorts inbound tickets
model: anthropic/claude-sonnet-5-5
fallbackModels: [openai/gpt-5]
instructions: { file: prompts/triage.md }
promptRef: triage@prod
modelSettings: { temperature: 0.2 }
reasoning: { budgetTokens: 4096 }
maxSteps: 20
evals: [ { dataset: triage, gates: [ { maxSteps: 10 } ], minPassRate: 0.9 } ]
`;

function graphOf(over: Record<string, unknown>): ReturnType<typeof specToGraph> {
  return specToGraph({
    version: 2,
    name: 'a',
    model: 'mock/mock-1',
    instructions: 'x',
    ...over,
  } as AgentSpecV2);
}

function inlineGraph(inlineOver: Record<string, unknown>): ReturnType<typeof specToGraph> {
  return graphOf({
    subagents: {
      r: {
        inline: {
          name: 'r',
          description: 'd',
          model: 'mock/mock-1',
          instructions: 'x',
          ...inlineOver,
        },
      },
    },
  });
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return { nodeId, severity: 'error', message, fieldPath };
}

describe('agent node: worked example', () => {
  it('round-trips the ticket spec unchanged', () => {
    const spec = parse(WORKED) as AgentSpecV2;
    expect(graphToSpec(specToGraph(spec)).spec).toStrictEqual(spec);
  });

  it('reports no problems for the worked example', () => {
    expect(validateGraph(specToGraph(parse(WORKED) as AgentSpecV2), { schema: false })).toStrictEqual([]);
  });
});

describe('agentRules.validate: root agent', () => {
  it.each<[Record<string, unknown>, string, string]>([
    [{ name: '' }, 'The agent needs a name', 'name'],
    [{ name: '   ' }, 'The agent needs a name', 'name'],
    [{ name: 'bad name!' }, 'The name can use letters, digits, space, dot, dash or underscore', 'name'],
    [{ name: '-leading-dash' }, 'The name can use letters, digits, space, dot, dash or underscore', 'name'],
    [{ model: '' }, 'Pick a model', 'model'],
    [{ model: 'noslash' }, 'Pick a model', 'model'],
    [{ model: 'openai/' }, 'Pick a model', 'model'],
    [{ instructions: '' }, 'The agent needs instructions', 'instructions'],
    [{ instructions: '   ' }, 'The agent needs instructions', 'instructions'],
    [{ instructions: { file: '' } }, 'The agent needs instructions', 'instructions'],
  ])('spec %j → "%s" at "%s"', (over, message, fieldPath) => {
    expect(validateGraph(graphOf(over), { schema: false })).toStrictEqual([error('agent', message, fieldPath)]);
  });

  it('does not require a description on the root agent', () => {
    expect(validateGraph(graphOf({ description: '' }), { schema: false })).toStrictEqual([]);
  });
});

describe('agentRules.validate: inline subagent', () => {
  it('requires a description, at the inline spec path', () => {
    expect(validateGraph(inlineGraph({ description: '' }), { schema: false })).toStrictEqual([
      error('sub:r', 'A subagent needs a description', 'subagents.r.inline.description'),
    ]);
  });

  it('maps field problems to the inline spec path', () => {
    expect(validateGraph(inlineGraph({ name: 'bad!', model: 'x' }), { schema: false })).toStrictEqual([
      error('sub:r', 'The name can use letters, digits, space, dot, dash or underscore', 'subagents.r.inline.name'),
      error('sub:r', 'Pick a model', 'subagents.r.inline.model'),
    ]);
  });

  it('nests the spec path for a subagent inside a subagent', () => {
    const graph = graphOf({
      subagents: {
        a: {
          inline: {
            name: 'a',
            description: 'd',
            model: 'mock/mock-1',
            instructions: 'x',
            subagents: {
              b: { inline: { name: 'b', model: 'mock/mock-1', instructions: 'x' } },
            },
          },
        },
      },
    });
    expect(validateGraph(graph, { schema: false })).toStrictEqual([
      error('sub:a/sub:b', 'A subagent needs a description', 'subagents.a.inline.subagents.b.inline.description'),
      {
        nodeId: 'sub:a/sub:b',
        severity: 'warning',
        message: "This subagent is deeper than the agent's max subagent depth (1)",
        fieldPath: 'subagents.a.inline.subagents.b.inline',
      },
    ]);
  });
});
