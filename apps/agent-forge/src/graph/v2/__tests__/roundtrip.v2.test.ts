import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import type { CanvasLayout } from '../../../../shared/wireTypes';
import { deriveEdges } from '../edges';
import { graphToSpec } from '../graphToSpec';
import type { AgentSpecV2 } from '../specTypes';
import { specToGraph } from '../specToGraph';
import type { AgentNodeData, Graph, McpNodeData } from '../types';

const WORKED = `version: 2
name: support-triage
model: anthropic/claude-sonnet-5-5
instructions: Triage tickets.
tools:
  - builtin: http
  - builtin: http
    approval: always
mcpServers:
  github: { command: npx, args: [-y, '@modelcontextprotocol/server-github'] }
subagents:
  research:
    inline:
      name: research
      description: Looks things up
      model: openai/gpt-5
      instructions: Research.
      tools: [ { builtin: web-fetch } ]
permissions:
  - { id: p1, tool: 'github__*', action: ask }
triggers:
  - { id: t1, type: chat }
x-team: platform
`;

const WORKED_LAYOUT: CanvasLayout = {
  schemaVersion: 1,
  nodes: { agent: { x: 300, y: 0 }, 'tool:http#2': { x: 600, y: 140 } },
  notes: [],
};

function workedSpec(): AgentSpecV2 {
  return parse(WORKED) as AgentSpecV2;
}

function minimalSpec(over: Record<string, unknown> = {}): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

/** Object.freeze every object in `value`, recursively. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe('specToGraph: worked example', () => {
  const spec = workedSpec();
  const graph = specToGraph(spec, WORKED_LAYOUT);

  it('produces exactly the listed node ids in order', () => {
    expect(graph.nodes.map((n) => n.id)).toEqual([
      'agent',
      'trigger:t1',
      'tool:http',
      'tool:http#2',
      'mcp:github',
      'sub:research',
      'sub:research/tool:web-fetch',
      'perm:p1',
    ]);
  });

  it('uses layout positions and records the rest in unplaced', () => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('agent')?.position).toStrictEqual({ x: 300, y: 0 });
    expect(byId.get('tool:http#2')?.position).toStrictEqual({ x: 600, y: 140 });
    expect(graph.unplaced).toEqual([
      'trigger:t1',
      'tool:http',
      'mcp:github',
      'sub:research',
      'sub:research/tool:web-fetch',
      'perm:p1',
    ]);
    expect(byId.get('trigger:t1')?.position).toStrictEqual({ x: 0, y: 0 });
    expect(byId.get('tool:http')?.position).toStrictEqual({ x: 512, y: 0 });
    expect(byId.get('mcp:github')?.position).toStrictEqual({ x: 512, y: 120 });
    expect(byId.get('sub:research')?.position).toStrictEqual({ x: 1024, y: 0 });
    expect(byId.get('sub:research/tool:web-fetch')?.position).toStrictEqual({ x: 24, y: 48 });
    expect(byId.get('perm:p1')?.position).toStrictEqual({ x: 768, y: 0 });
  });

  it('puts unknown keys in the root extra', () => {
    expect((graph.nodes[0].data as AgentNodeData).extra).toStrictEqual({ 'x-team': 'platform' });
  });

  it('derives the listed edges', () => {
    const ids = deriveEdges(graph).map((e) => e.id);
    expect(ids).toContain('governs:mcp:github->perm:p1');
    expect(ids).toContain('starts:trigger:t1->agent');
    expect(ids).toContain('delegates:agent->sub:research');
    expect(ids).toContain('uses:sub:research->sub:research/tool:web-fetch');
  });

  it('round-trips to an identical spec and layout', () => {
    const result = graphToSpec(graph, spec);
    expect(result.spec).toStrictEqual(spec);
    // Layout entries pass through unchanged; fallback positions are persisted for the nodes that had none.
    expect(result.layout.nodes).toStrictEqual({
      agent: { x: 300, y: 0 },
      'trigger:t1': { x: 0, y: 0 },
      'tool:http': { x: 512, y: 0 },
      'tool:http#2': { x: 600, y: 140 },
      'mcp:github': { x: 512, y: 120 },
      'sub:research': { x: 1024, y: 0 },
      'sub:research/tool:web-fetch': { x: 24, y: 48 },
      'perm:p1': { x: 768, y: 0 },
    });
    expect(result.layout.notes).toStrictEqual([]);
    expect(result.layout.viewport).toBeUndefined();
    for (const [id, mapped] of Object.entries(result.nodeIdMap)) {
      expect(mapped, id).toBe(id);
    }
  });

  it('reports spec paths for every emitted node', () => {
    const result = graphToSpec(graph, spec);
    expect(result.specPaths['agent']).toBe('');
    expect(result.specPaths['tool:http#2']).toBe('tools[1]');
    expect(result.specPaths['mcp:github']).toBe('mcpServers.github');
    expect(result.specPaths['sub:research']).toBe('subagents.research.inline');
    expect(result.specPaths['sub:research/tool:web-fetch']).toBe('subagents.research.inline.tools[0]');
    expect(result.specPaths['perm:p1']).toBe('permissions[0]');
    expect(result.specPaths['trigger:t1']).toBe('triggers[0]');
  });
});

describe('specToGraph: sections', () => {
  it('keeps empty sections so they round-trip', () => {
    const spec = minimalSpec({ tools: [], mcpServers: {} });
    const graph = specToGraph(spec);
    expect(graph.nodes.map((n) => n.id)).toEqual(['agent']);
    expect(graph.emptySections).toEqual([
      { owner: 'agent', key: 'tools' },
      { owner: 'agent', key: 'mcpServers' },
    ]);
    expect(graphToSpec(graph, spec).spec).toStrictEqual(spec);
  });

  it('keeps an empty section inside an inline subagent', () => {
    const spec = minimalSpec({
      subagents: {
        r: {
          inline: {
            name: 'r',
            description: 'd',
            model: 'mock/mock-1',
            instructions: 'x',
            tools: [],
          },
        },
      },
    });
    const graph = specToGraph(spec);
    expect(graph.emptySections).toEqual([{ owner: 'sub:r', key: 'tools' }]);
    expect(graphToSpec(graph, spec).spec).toStrictEqual(spec);
  });

  it('dedupes repeated tool ids with #2', () => {
    const graph = specToGraph(minimalSpec({ tools: [{ builtin: 'http' }, { builtin: 'http' }] }));
    expect(graph.nodes.map((n) => n.id)).toEqual(['agent', 'tool:http', 'tool:http#2']);
  });

  it('keeps notes and viewport from the layout', () => {
    const layout: CanvasLayout = {
      schemaVersion: 1,
      nodes: {},
      notes: [{ id: 'n1', x: 5, y: 6, text: 'remember' }],
      viewport: { x: 1, y: 2, zoom: 1.5 },
    };
    const graph = specToGraph(minimalSpec(), layout);
    const note = graph.nodes.at(-1);
    expect(note).toStrictEqual({
      id: 'note:n1',
      kind: 'note',
      owner: null,
      position: { x: 5, y: 6 },
      data: { text: 'remember' },
    });
    expect(graph.viewport).toStrictEqual({ x: 1, y: 2, zoom: 1.5 });
    const result = graphToSpec(graph);
    expect(result.layout.notes).toStrictEqual([{ id: 'n1', x: 5, y: 6, text: 'remember' }]);
    expect(result.layout.viewport).toStrictEqual({ x: 1, y: 2, zoom: 1.5 });
  });
});

describe('graphToSpec: edits', () => {
  it('moves a renamed mcp key to its new node id, keeping position', () => {
    const spec = workedSpec();
    const layout: CanvasLayout = {
      schemaVersion: 1,
      nodes: { agent: { x: 300, y: 0 }, 'mcp:github': { x: 42, y: 64 } },
      notes: [],
    };
    const graph = specToGraph(spec, layout);
    const mcp = graph.nodes.find((n) => n.id === 'mcp:github');
    expect(mcp).toBeDefined();
    (mcp?.data as McpNodeData).key = 'gh';
    const result = graphToSpec(graph, spec);
    expect(Object.keys(result.spec.mcpServers ?? {})).toEqual(['gh']);
    expect(result.spec.mcpServers?.['gh']).toStrictEqual(spec.mcpServers?.['github']);
    expect(result.nodeIdMap['mcp:github']).toBe('mcp:gh');
    expect(result.layout.nodes['mcp:gh']).toStrictEqual({ x: 42, y: 64 });
  });

  it('omits proposed: remove nodes and never writes the proposed field', () => {
    const spec = workedSpec();
    const graph = specToGraph(spec, WORKED_LAYOUT);
    const doomed = graph.nodes.find((n) => n.id === 'tool:http#2');
    expect(doomed).toBeDefined();
    if (doomed !== undefined) doomed.proposed = 'remove';
    const result = graphToSpec(graph, spec);
    expect(result.spec.tools).toStrictEqual([{ builtin: 'http' }]);
    expect(JSON.stringify(result)).not.toContain('"proposed"');
  });

  it('throws the exact error on a graph without an agent node', () => {
    const graph: Graph = { version: 2, nodes: [], emptySections: [], unplaced: [] };
    expect(() => graphToSpec(graph)).toThrow('graphToSpec: graph has no root agent node');
  });
});

describe('immutability', () => {
  it('converts a deep-frozen spec and layout without mutating them', () => {
    const spec = deepFreeze(workedSpec());
    const layout = deepFreeze(WORKED_LAYOUT);
    const graph = specToGraph(spec, layout);
    const result = graphToSpec(graph, spec);
    expect(result.spec).toStrictEqual(spec);
  });
});
