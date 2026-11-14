import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { deriveEdges } from '../../edges';
import { graphToSpec } from '../../graphToSpec';
import { connectNodes, duplicateNode } from '../../mutations';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2 } from '../../specTypes';
import type { Graph, OutputNodeData, Problem } from '../../types';
import { validateGraph } from '../../validateGraph';

/** The ticket's worked example: an object schema with two required fields. */
const WORKED = `version: 2
name: triage
model: mock/mock-1
instructions: Triage tickets.
output:
  jsonSchema:
    type: object
    properties:
      priority: { type: string, enum: [low, normal, urgent] }
      summary: { type: string, description: One sentence }
    required: [priority, summary]
    additionalProperties: false
`;

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(output: Record<string, unknown>, over: Record<string, unknown> = {}): Graph {
  return specToGraph(specOf({ output, ...over }));
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return { nodeId, severity: 'error', message, fieldPath };
}

const item = (graph: Graph, id: string) =>
  (graph.nodes.find((n) => n.id === id)!.data as OutputNodeData).item;

describe('specToGraph: output worked example', () => {
  const spec = parse(WORKED) as AgentSpecV2;
  const graph = specToGraph(spec);

  it('produces one output node owned by the root agent', () => {
    const outputs = graph.nodes.filter((n) => n.kind === 'output');
    expect(outputs.map((n) => n.id)).toEqual(['output']);
    expect(outputs[0].owner).toBe('agent');
    expect(item(graph, 'output')).toStrictEqual(spec.output);
  });

  it('draws the returns edge from the agent', () => {
    expect(deriveEdges(graph).map((e) => e.id)).toContain('returns:agent->output');
  });

  it('round-trips to an identical spec', () => {
    expect(graphToSpec(specToGraph(spec)).spec).toStrictEqual(spec);
  });

  it('round-trips promptSchema and responseFormat', () => {
    const withOptions = specOf({
      output: {
        jsonSchema: { type: 'object' },
        promptSchema: false,
        responseFormat: 'always',
      },
    });
    expect(graphToSpec(specToGraph(withOptions)).spec.output).toStrictEqual(withOptions.output);
  });
});

describe('output node ids', () => {
  it('ids an inline subagent output sub:<key>/output', () => {
    const g = specToGraph(
      specOf({
        output: { jsonSchema: { type: 'object' } },
        subagents: {
          r: {
            inline: {
              name: 'r',
              description: 'd',
              model: 'mock/mock-1',
              instructions: 'x',
              output: { jsonSchema: { type: 'object' } },
            },
          },
        },
      }),
    );
    // `subagents` precedes `output` in SECTION_ORDER, so the inline agent's
    // subtree (including its output node) is pushed first.
    const ids = g.nodes.filter((n) => n.kind === 'output').map((n) => n.id);
    expect(ids).toEqual(['sub:r/output', 'output']);
    expect(g.nodes.find((n) => n.id === 'sub:r/output')!.owner).toBe('sub:r');
    expect(deriveEdges(g).map((e) => e.id)).toContain('returns:sub:r->sub:r/output');
  });
});

describe('outputRules.validate', () => {
  it('flags a schema that is not an object schema', () => {
    for (const jsonSchema of ['x', 42, ['object'], { type: 'string' }, {}]) {
      const g = graphOf({ jsonSchema });
      expect(validateGraph(g, { schema: false })).toStrictEqual([
        error('output', 'The output schema must be an object schema', 'output.jsonSchema'),
      ]);
    }
  });

  it("flags a required entry that names no property", () => {
    const g = graphOf({
      jsonSchema: {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a', 'b'],
      },
    });
    expect(validateGraph(g, { schema: false })).toStrictEqual([
      error('output', "'b' is required but not defined", 'output.jsonSchema.required'),
    ]);
  });

  it('accepts a valid object schema', () => {
    const g = graphOf({
      jsonSchema: {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
      },
      promptSchema: false,
      responseFormat: 'always',
    });
    expect(validateGraph(g, { schema: false })).toStrictEqual([]);
  });

  it('maps the problem to the nested spec path inside an inline agent', () => {
    const g = specToGraph(
      specOf({
        subagents: {
          r: {
            inline: {
              name: 'r',
              description: 'd',
              model: 'mock/mock-1',
              instructions: 'x',
              output: { jsonSchema: { type: 'array' } },
            },
          },
        },
      }),
    );
    expect(validateGraph(g, { schema: false })).toStrictEqual([
      error(
        'sub:r/output',
        'The output schema must be an object schema',
        'subagents.r.inline.output.jsonSchema',
      ),
    ]);
  });
});

describe('output node connections and duplicates', () => {
  it('refuses agent → output when the agent already has an output schema', () => {
    const g = specToGraph(
      specOf({
        output: { jsonSchema: { type: 'object' } },
        subagents: {
          r: {
            inline: {
              name: 'r',
              description: 'd',
              model: 'mock/mock-1',
              instructions: 'x',
              output: { jsonSchema: { type: 'object' } },
            },
          },
        },
      }),
    );
    // sub:r already owns sub:r/output; the root's `output` belongs to another agent.
    const result = connectNodes(g, 'sub:r', 'output');
    expect(result).toEqual({ ok: false, reason: 'This agent already has an output schema' });
  });

  it('re-owns an output schema onto an agent that has none', () => {
    const g = specToGraph(
      specOf({
        output: { jsonSchema: { type: 'object' } },
        subagents: {
          r: {
            inline: {
              name: 'r',
              description: 'd',
              model: 'mock/mock-1',
              instructions: 'x',
            },
          },
        },
      }),
    );
    const result = connectNodes(g, 'sub:r', 'output');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph.nodes.find((n) => n.id === 'output')!.owner).toBe('sub:r');
      expect(deriveEdges(result.graph).map((e) => e.id)).toContain('returns:sub:r->output');
      expect(deriveEdges(result.graph).map((e) => e.id)).not.toContain('returns:agent->output');
    }
  });

  it('refuses to duplicate an output node', () => {
    const g = graphOf({ jsonSchema: { type: 'object' } });
    const result = duplicateNode(g, 'output');
    expect(result.nodeId).toBeUndefined();
    expect(result.graph).toBe(g);
  });
});
