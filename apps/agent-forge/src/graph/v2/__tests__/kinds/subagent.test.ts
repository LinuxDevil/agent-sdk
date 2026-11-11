import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { deriveEdges } from '../../edges';
import { graphToSpec } from '../../graphToSpec';
import { duplicateNode } from '../../mutations';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2 } from '../../specTypes';
import type { AgentNodeData, Problem, SubagentNodeData } from '../../types';
import { validateGraph } from '../../validateGraph';

/** The ticket's worked example: a ref, a remote and an inline subagent. */
const WORKED = `version: 2
name: support-triage
model: anthropic/claude-sonnet-5-5
instructions: Triage tickets.
subagents:
  billing: { ref: agents/billing.yaml }
  search:
    remote: { url: https://search.example.com, auth: { secret: search-token }, description: Web search agent }
  research:
    inline: { name: research, description: Looks things up, model: openai/gpt-5, instructions: Research., tools: [ { builtin: web-fetch } ] }
`;

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(over: Record<string, unknown>): ReturnType<typeof specToGraph> {
  return specToGraph(specOf(over));
}

function problem(nodeId: string, severity: 'error' | 'warning', message: string, fieldPath: string): Problem {
  return { nodeId, severity, message, fieldPath };
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return problem(nodeId, 'error', message, fieldPath);
}

describe('specToGraph: subagent worked example', () => {
  const graph = specToGraph(parse(WORKED) as AgentSpecV2);

  it('produces the three subagent nodes plus the inline tool, in order', () => {
    expect(graph.nodes.map((n) => n.id)).toEqual([
      'agent',
      'sub:billing',
      'sub:search',
      'sub:research',
      'sub:research/tool:web-fetch',
    ]);
  });

  it('shapes each node\'s data from its spec entry', () => {
    const [billing, search, research, tool] = graph.nodes.slice(1);
    expect(billing).toMatchObject({ kind: 'subagent', data: { key: 'billing', item: { ref: 'agents/billing.yaml' } } });
    expect(search).toMatchObject({
      kind: 'subagent',
      data: {
        key: 'search',
        item: { remote: { url: 'https://search.example.com', auth: { secret: 'search-token' }, description: 'Web search agent' } },
      },
    });
    expect(research).toMatchObject({ kind: 'agent', data: { subagentKey: 'research' } });
    expect(tool.owner).toBe('sub:research');
  });

  it('derives the delegates and uses edges', () => {
    const ids = deriveEdges(graph).map((e) => e.id);
    expect(ids).toContain('delegates:agent->sub:billing');
    expect(ids).toContain('delegates:agent->sub:search');
    expect(ids).toContain('delegates:agent->sub:research');
    expect(ids).toContain('uses:sub:research->sub:research/tool:web-fetch');
  });

  it('round-trips to an identical spec', () => {
    const spec = parse(WORKED) as AgentSpecV2;
    expect(graphToSpec(specToGraph(spec)).spec).toStrictEqual(spec);
  });
});

describe('subagentRules.validate', () => {
  it('requires a ref agent', () => {
    const graph = graphOf({ subagents: { billing: { ref: '' } } });
    expect(validateGraph(graph, { schema: false })).toStrictEqual([
      error('sub:billing', 'Pick the agent this subagent runs', 'subagents.billing.ref'),
    ]);
  });

  it.each(['', 'not a url', 'http://agents.example.com/x', 'ftp://x'])(
    'rejects the remote url %j',
    (url) => {
      const graph = graphOf({
        subagents: { search: { remote: { url, description: 'd' } } },
      });
      expect(validateGraph(graph, { schema: false })).toStrictEqual([
        error('sub:search', 'The remote agent needs a full URL', 'subagents.search.remote.url'),
      ]);
    },
  );

  it.each(['https://agents.example.com', 'http://localhost:8080', 'http://127.0.0.1:9'])(
    'accepts the remote url %j',
    (url) => {
      const graph = graphOf({
        subagents: { search: { remote: { url, description: 'd' } } },
      });
      expect(validateGraph(graph, { schema: false })).toStrictEqual([]);
    },
  );

  it('requires a remote description', () => {
    const graph = graphOf({
      subagents: { search: { remote: { url: 'https://search.example.com', description: ' ' } } },
    });
    expect(validateGraph(graph, { schema: false })).toStrictEqual([
      error('sub:search', 'A remote agent needs a description', 'subagents.search.remote.description'),
    ]);
  });

  it('maps problems to the nested spec path inside an inline agent', () => {
    const graph = graphOf({
      subagents: {
        a: {
          inline: {
            name: 'a',
            description: 'd',
            model: 'mock/mock-1',
            instructions: 'x',
            subagents: { b: { remote: { url: 'x', description: '' } } },
          },
        },
      },
    });
    expect(validateGraph(graph, { schema: false })).toEqual(
      expect.arrayContaining([
        error('sub:a/sub:b', 'The remote agent needs a full URL', 'subagents.a.inline.subagents.b.remote.url'),
        error('sub:a/sub:b', 'A remote agent needs a description', 'subagents.a.inline.subagents.b.remote.description'),
      ]),
    );
  });
});

describe('agentRules.validate: subagent depth', () => {
  const nested = {
    subagents: {
      a: {
        inline: {
          name: 'a',
          description: 'd',
          model: 'mock/mock-1',
          instructions: 'x',
          subagents: {
            b: { inline: { name: 'b', description: 'd', model: 'mock/mock-1', instructions: 'x' } },
          },
        },
      },
    },
  };

  it('warns when an inline subagent is deeper than the default max depth of 1', () => {
    expect(validateGraph(graphOf(nested), { schema: false })).toStrictEqual([
      problem('sub:a/sub:b', 'warning', "This subagent is deeper than the agent's max subagent depth (1)", 'subagents.a.inline.subagents.b.inline'),
    ]);
  });

  it('reads the root agent\'s maxSubagentDepth', () => {
    const graph = specOf({ ...nested, maxSubagentDepth: 2 });
    expect(validateGraph(specToGraph(graph), { schema: false })).toStrictEqual([]);
  });

  it('does not warn at depth 1', () => {
    const graph = graphOf({
      subagents: {
        a: { inline: { name: 'a', description: 'd', model: 'mock/mock-1', instructions: 'x' } },
      },
    });
    expect(validateGraph(graph, { schema: false })).toStrictEqual([]);
  });
});

describe('duplicate', () => {
  const graph = specToGraph(parse(WORKED) as AgentSpecV2);

  it('gives a duplicated subagent a "<key>-copy" key', () => {
    const r = duplicateNode(graph, 'sub:billing');
    expect(r.nodeId).toBe('sub:billing-copy');
    const clone = r.graph.nodes.find((n) => n.id === r.nodeId);
    expect((clone?.data as SubagentNodeData).key).toBe('billing-copy');
    expect((clone?.data as SubagentNodeData).item).toStrictEqual({ ref: 'agents/billing.yaml' });
  });

  it('appends -copy again on a second duplicate (uniqueName only dedupes identical keys)', () => {
    const first = duplicateNode(graph, 'sub:billing').graph;
    const r = duplicateNode(first, 'sub:billing-copy');
    const clone = r.graph.nodes.find((n) => n.id === r.nodeId);
    expect((clone?.data as SubagentNodeData).key).toBe('billing-copy-copy');
  });

  it('gives a duplicated inline agent a "<key>-copy" subagentKey and no children', () => {
    const r = duplicateNode(graph, 'sub:research');
    expect(r.nodeId).toBe('sub:research-copy');
    const clone = r.graph.nodes.find((n) => n.id === r.nodeId);
    expect((clone?.data as AgentNodeData).subagentKey).toBe('research-copy');
    expect(r.graph.nodes.filter((n) => n.owner === r.nodeId)).toEqual([]);
    const entry = graphToSpec(r.graph).spec.subagents?.['research-copy'] as { inline: Record<string, unknown> };
    expect(entry.inline).not.toHaveProperty('tools');
  });
});
