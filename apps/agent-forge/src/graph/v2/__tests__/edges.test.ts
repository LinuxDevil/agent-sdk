import { describe, expect, it } from 'vitest';

import { deriveEdges, EDGE_LABELS, globMatch } from '../edges';
import type { EdgeKind, Graph, GraphNode, NodeKind } from '../types';

/** Minimal node factory: position and ids are irrelevant to edge derivation. */
function node(kind: NodeKind, id: string, owner: string | null, data: GraphNode['data']): GraphNode {
  return { id, kind, owner, position: { x: 0, y: 0 }, data } as GraphNode;
}

function graphOf(nodes: GraphNode[]): Graph {
  return { version: 2, nodes, emptySections: [], unplaced: [] };
}

const ROOT = node('agent', 'agent', null, {
  fields: { name: 'a', model: 'mock/mock-1', instructions: 'x' },
  extra: {},
});

describe('globMatch', () => {
  it('matches a trailing star', () => {
    expect(globMatch('github_*', 'github_issue')).toBe(true);
    expect(globMatch('github__*', 'github__x')).toBe(true);
    expect(globMatch('github__*', 'fs__x')).toBe(false);
  });

  it('matches any run including the empty run', () => {
    expect(globMatch('*', 'anything')).toBe(true);
    expect(globMatch('a*c', 'abc')).toBe(true);
    expect(globMatch('a*c', 'ac')).toBe(true);
  });

  it('matches ? as exactly one character', () => {
    expect(globMatch('h?tp', 'http')).toBe(true);
    expect(globMatch('h?tp', 'htp')).toBe(false);
    expect(globMatch('h?tp', 'httpx')).toBe(false);
  });

  it('treats a dot as literal', () => {
    expect(globMatch('a.c', 'a.c')).toBe(true);
    expect(globMatch('a.c', 'abc')).toBe(false);
  });

  it('matches literals exactly', () => {
    expect(globMatch('http', 'http')).toBe(true);
    expect(globMatch('http', 'http_request')).toBe(false);
  });
});

describe('EDGE_LABELS', () => {
  it('labels each edge kind, with empty labels for uses and next', () => {
    const expected: Record<EdgeKind, string> = {
      starts: 'starts',
      uses: '',
      delegates: 'delegates',
      handsOff: 'hands off',
      guards: 'guards',
      governs: 'governs',
      hooks: 'hooks',
      returns: 'returns',
      cancels: 'cancels',
      runs: 'runs',
      next: '',
    };
    expect(EDGE_LABELS).toStrictEqual(expected);
  });
});

describe('deriveEdges', () => {
  it('draws owner -> node uses edges for tool, mcp, skill and memory', () => {
    const graph = graphOf([
      ROOT,
      node('tool', 'tool:http', 'agent', { item: { builtin: 'http' } }),
      node('mcp', 'mcp:github', 'agent', { key: 'github', item: { command: 'npx' } }),
      node('skill', 'skill:a', 'agent', { item: { dir: 'skills/a' } }),
      node('memory', 'memory:m1', 'agent', { item: { name: 'm1', scope: 'session', provider: { type: 'in-memory' } } }),
    ]);
    const edges = deriveEdges(graph);
    expect(edges.map((e) => e.id)).toEqual([
      'uses:agent->tool:http',
      'uses:agent->mcp:github',
      'uses:agent->skill:a',
      'uses:agent->memory:m1',
    ]);
    for (const e of edges) expect(e.label).toBeUndefined();
  });

  it('draws owner -> node delegates edges for subagent and inline agent nodes', () => {
    const graph = graphOf([
      ROOT,
      node('subagent', 'sub:ext', 'agent', { key: 'ext', item: { ref: 'agents/x.yaml' } }),
      node('agent', 'sub:inl', 'agent', {
        fields: { name: 'i', model: 'm', instructions: 'x', description: 'd' },
        extra: {},
        subagentKey: 'inl',
      }),
    ]);
    expect(deriveEdges(graph).map((e) => e.id)).toEqual([
      'delegates:agent->sub:ext',
      'delegates:agent->sub:inl',
    ]);
    expect(deriveEdges(graph).map((e) => e.label)).toEqual(['delegates', 'delegates']);
  });

  it('draws handoff, guardrail, hook and output edges from the owner', () => {
    const graph = graphOf([
      ROOT,
      node('handoff', 'handoff:b', 'agent', { item: { agent: 'b' } }),
      node('guardrail', 'guard:g1', 'agent', { item: { id: 'g1', name: 'max-length' } }),
      node('hook', 'hook:h1', 'agent', { item: { id: 'h1', file: 'hooks/h.ts' } }),
      node('output', 'output', 'agent', { item: { jsonSchema: {} } }),
    ]);
    const edges = deriveEdges(graph);
    expect(edges.map((e) => e.id)).toEqual([
      'handsOff:agent->handoff:b',
      'guards:agent->guard:g1',
      'hooks:agent->hook:h1',
      'returns:agent->output',
    ]);
    expect(edges.map((e) => e.label)).toEqual(['hands off', 'guards', 'hooks', 'returns']);
  });

  it('draws trigger -> agent starts edges', () => {
    const graph = graphOf([ROOT, node('trigger', 'trigger:t1', 'agent', { item: { id: 't1', type: 'chat' } })]);
    expect(deriveEdges(graph)).toEqual([
      { id: 'starts:trigger:t1->agent', kind: 'starts', source: 'trigger:t1', target: 'agent', label: 'starts' },
    ]);
  });

  it('draws trigger -> abort cancels edges only when the trigger node exists', () => {
    const abort = node('abort', 'abort:a1', 'agent', {
      item: { id: 'a1', triggerId: 't1', when: 'true', match: 'true', scope: 'both' },
    });
    const withTrigger = graphOf([
      ROOT,
      node('trigger', 'trigger:t1', 'agent', { item: { id: 't1', type: 'chat' } }),
      abort,
    ]);
    expect(deriveEdges(withTrigger).map((e) => e.id)).toEqual([
      'starts:trigger:t1->agent',
      'cancels:trigger:t1->abort:a1',
    ]);
    expect(deriveEdges(graphOf([ROOT, abort]))).toEqual([]);
  });

  it('draws governs edges from tools matching the rule glob and same-owner mcp servers', () => {
    const graph = graphOf([
      ROOT,
      node('tool', 'tool:http', 'agent', { item: { builtin: 'http' } }),
      node('tool', 'tool:github-issues', 'agent', { item: { registry: 'github-issues' } }),
      node('mcp', 'mcp:github', 'agent', { key: 'github', item: { command: 'npx' } }),
      node('mcp', 'mcp:fs', 'agent', { key: 'fs', item: { command: 'npx' } }),
      node('permission', 'perm:p1', 'agent', { item: { id: 'p1', tool: ['github*', 'github__*'], action: 'ask' } }),
    ]);
    const edges = deriveEdges(graph);
    expect(edges.filter((e) => e.kind === 'governs').map((e) => e.id)).toEqual([
      'governs:tool:github-issues->perm:p1',
      'governs:mcp:github->perm:p1',
    ]);
  });

  it('matches a permission with an array tool glob and * against mcp servers', () => {
    const graph = graphOf([
      ROOT,
      node('tool', 'tool:http', 'agent', { item: { builtin: 'http' } }),
      node('tool', 'tool:web-fetch', 'agent', { item: { builtin: 'web-fetch' } }),
      node('mcp', 'mcp:fs', 'agent', { key: 'fs', item: { command: 'npx' } }),
      node('permission', 'perm:p2', 'agent', { item: { id: 'p2', tool: ['http', 'web-*'], action: 'allow' } }),
      node('permission', 'perm:p3', 'agent', { item: { id: 'p3', tool: '*', action: 'deny' } }),
    ]);
    const edges = deriveEdges(graph);
    expect(edges.filter((e) => e.target === 'perm:p2').map((e) => e.id)).toEqual([
      'governs:tool:http->perm:p2',
      'governs:tool:web-fetch->perm:p2',
    ]);
    expect(edges.filter((e) => e.target === 'perm:p3').map((e) => e.id)).toEqual([
      'governs:tool:http->perm:p3',
      'governs:tool:web-fetch->perm:p3',
      'governs:mcp:fs->perm:p3',
    ]);
  });

  it('draws owner -> permission when no tool or mcp matches', () => {
    const graph = graphOf([
      ROOT,
      node('tool', 'tool:http', 'agent', { item: { builtin: 'http' } }),
      node('permission', 'perm:p9', 'agent', { item: { id: 'p9', tool: 'nomatch-*', action: 'ask' } }),
    ]);
    expect(deriveEdges(graph).filter((e) => e.kind === 'governs')).toEqual([
      { id: 'governs:agent->perm:p9', kind: 'governs', source: 'agent', target: 'perm:p9', label: 'governs' },
    ]);
  });

  it('scopes permission matches to the same owner', () => {
    const sub = node('agent', 'sub:r', 'agent', {
      fields: { name: 'r', model: 'm', instructions: 'x', description: 'd' },
      extra: {},
      subagentKey: 'r',
    });
    const graph = graphOf([
      ROOT,
      sub,
      node('tool', 'tool:http', 'agent', { item: { builtin: 'http' } }),
      node('permission', 'sub:r/perm:p1', 'sub:r', { item: { id: 'p1', tool: 'http', action: 'ask' } }),
    ]);
    // The root's tool does not govern a permission owned by the inline subagent.
    expect(deriveEdges(graph).filter((e) => e.kind === 'governs')).toEqual([
      { id: 'governs:sub:r->sub:r/perm:p1', kind: 'governs', source: 'sub:r', target: 'sub:r/perm:p1', label: 'governs' },
    ]);
  });

  it('draws a handsOff edge from a handoff to a same-owner inline subagent', () => {
    const graph = graphOf([
      ROOT,
      node('agent', 'sub:r', 'agent', {
        fields: { name: 'r', model: 'm', instructions: 'x', description: 'd' },
        extra: {},
        subagentKey: 'r',
      }),
      node('handoff', 'handoff:r', 'agent', { item: { agent: 'r' } }),
    ]);
    expect(deriveEdges(graph).map((e) => e.id)).toEqual([
      'delegates:agent->sub:r',
      'handsOff:agent->handoff:r',
      'handsOff:handoff:r->sub:r',
    ]);
  });

  it('does not draw the handoff edge to a subagent of another owner', () => {
    const graph = graphOf([
      ROOT,
      node('agent', 'sub:r', 'agent', {
        fields: { name: 'r', model: 'm', instructions: 'x', description: 'd' },
        extra: {},
        subagentKey: 'r',
      }),
      node('subagent', 'sub:r/sub:b', 'sub:r', { key: 'b', item: { ref: 'agents/b.yaml' } }),
      node('handoff', 'handoff:b', 'agent', { item: { agent: 'b' } }),
    ]);
    const edges = deriveEdges(graph);
    expect(edges.filter((e) => e.source === 'handoff:b')).toEqual([]);
    expect(edges.map((e) => e.id)).toEqual([
      'delegates:agent->sub:r',
      'delegates:sub:r->sub:r/sub:b',
      'handsOff:agent->handoff:b',
    ]);
  });

  it('draws only the derived runs edge for a lone flow root, and none for a note', () => {
    const graph = graphOf([
      ROOT,
      node('flow', 'flow:e1', 'agent', { step: { type: 'end', id: 'e1' }, children: { shape: 'none' } }),
      node('note', 'note:n1', null, { text: 'hi' }),
    ]);
    expect(deriveEdges(graph).map((e) => e.id)).toEqual(['runs:agent->flow:e1']);
  });
});
