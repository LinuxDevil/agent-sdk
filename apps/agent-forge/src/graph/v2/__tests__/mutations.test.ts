import { describe, expect, it } from 'vitest';

import type { CanvasLayout } from '../../../../shared/wireTypes';
import { KIND_VIEWS } from '../../../canvas/kinds';
import { graphToSpec } from '../graphToSpec';
import {
  addNode,
  connectNodes,
  duplicateNode,
  moveNode,
  ownerForNewNode,
  patchNode,
  removeNode,
  reownNode,
  setCollapsed,
  setNodeData,
} from '../mutations';
import { uniqueName } from '../nodeIds';
import type { AgentSpecV2 } from '../specTypes';
import { specToGraph } from '../specToGraph';
import type {
  AgentNodeData,
  Graph,
  GraphNode,
  McpNodeData,
  NodeKind,
  SubagentNodeData,
  ToolNodeData,
} from '../types';
import { ROOT_ONLY_KINDS } from '../types';
import { arbSpec } from './arbitraries';
import { int, mulberry32, pick } from './prng';

type Rng = () => number;

function minimalSpec(over: Record<string, unknown> = {}): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

/** A minimal inline subagent spec entry (description is required on inline agents). */
function inlineAgent(over: Record<string, unknown> = {}): { inline: Record<string, unknown> } {
  return {
    inline: { name: 's', description: 'd', model: 'mock/mock-1', instructions: 'x', ...over },
  };
}

/**
 * `agent` → `tool:http`; `agent` → `sub:r` → (`tool:x`, `sub:s` → `tool:y`) —
 * the tree the owner/descendant cases walk.
 */
function treeSpec(): AgentSpecV2 {
  return minimalSpec({
    tools: [{ builtin: 'http' }],
    subagents: {
      r: inlineAgent({
        name: 'r',
        tools: [{ builtin: 'x' }],
        subagents: { s: inlineAgent({ name: 's', tools: [{ builtin: 'y' }] }) },
      }),
    },
  });
}

function nodeById(graph: Graph, id: string): GraphNode {
  const node = graph.nodes.find((n) => n.id === id);
  if (node === undefined) throw new Error(`no node '${id}'`);
  return node;
}

function toolItem(graph: Graph, id: string): Record<string, unknown> {
  return (nodeById(graph, id).data as ToolNodeData).item as Record<string, unknown>;
}

/** Object.freeze every object in `value`, recursively. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const AT = { x: 10, y: 20 };

describe('addNode', () => {
  it('dedupes ids with #2 and prefixes the owner id', () => {
    const g0 = specToGraph(minimalSpec());
    const data: GraphNode['data'] = { item: { builtin: 'http' } };
    const r1 = addNode(g0, { kind: 'tool', data }, AT, 'agent');
    expect(r1.nodeId).toBe('tool:http');
    const r2 = addNode(r1.graph, { kind: 'tool', data }, AT, 'agent');
    expect(r2.nodeId).toBe('tool:http#2');
    const node = nodeById(r1.graph, 'tool:http');
    expect(node.kind).toBe('tool');
    expect(node.owner).toBe('agent');
    expect(node.position).toStrictEqual(AT);
  });

  it('prefixes child ids with an inline-agent owner', () => {
    const g0 = specToGraph(treeSpec());
    const r = addNode(g0, { kind: 'tool', data: { item: { builtin: 'http' } } }, AT, 'sub:r');
    expect(r.nodeId).toBe('sub:r/tool:http');
    expect(nodeById(r.graph, 'sub:r/tool:http').owner).toBe('sub:r');
  });

  it('gives notes a note:n id and a null owner', () => {
    const g0 = specToGraph(minimalSpec());
    const r = addNode(g0, { kind: 'note', data: { text: 'hi' } }, AT, null);
    expect(r.nodeId).toMatch(/^note:n/);
    expect(nodeById(r.graph, r.nodeId).owner).toBeNull();
  });
});

describe('ownerForNewNode', () => {
  const g = specToGraph(treeSpec());

  it('defaults to the root agent when nothing is selected', () => {
    expect(ownerForNewNode(g, 'tool')).toBe('agent');
  });

  it('uses the selected agent', () => {
    expect(ownerForNewNode(g, 'tool', 'sub:r')).toBe('sub:r');
    expect(ownerForNewNode(g, 'tool', 'agent')).toBe('agent');
  });

  it('uses the selected node\'s owner', () => {
    expect(ownerForNewNode(g, 'tool', 'sub:r/tool:x')).toBe('sub:r');
  });

  it('forces root-only kinds onto the root agent', () => {
    expect(ownerForNewNode(g, 'trigger', 'sub:r')).toBe('agent');
    expect(ownerForNewNode(g, 'abort', 'sub:r')).toBe('agent');
  });

  it('gives notes a null owner', () => {
    expect(ownerForNewNode(g, 'note', 'sub:r')).toBeNull();
  });
});

describe('patchNode', () => {
  const g = specToGraph(minimalSpec({ tools: [{ builtin: 'http' }] }));

  it('sets a key on data.item and deletes it on undefined', () => {
    const g1 = patchNode(g, 'tool:http', { approval: 'always' });
    expect(toolItem(g1, 'tool:http')['approval']).toBe('always');
    const g2 = patchNode(g1, 'tool:http', { approval: undefined });
    expect('approval' in toolItem(g2, 'tool:http')).toBe(false);
  });

  it('edits data.fields on the root agent', () => {
    const g1 = patchNode(g, 'agent', { description: 'triages' });
    expect((nodeById(g1, 'agent').data as AgentNodeData).fields.description).toBe('triages');
    expect((nodeById(g, 'agent').data as AgentNodeData).fields.description).toBeUndefined();
  });
});

describe('removeNode', () => {
  it('returns the same reference for the root agent', () => {
    const g = specToGraph(treeSpec());
    expect(removeNode(g, 'agent')).toBe(g);
  });

  it('removes an inline subagent\'s whole subtree', () => {
    const g = specToGraph(treeSpec());
    const g1 = removeNode(g, 'sub:r');
    expect(g1.nodes.map((n) => n.id)).toEqual(['agent', 'tool:http']);
  });

  it('drops empty sections owned by a removed agent', () => {
    const g = specToGraph(
      minimalSpec({ tools: [], subagents: { r: inlineAgent({ name: 'r', tools: [] }) } })
    );
    expect(g.emptySections).toEqual([
      { owner: 'agent', key: 'tools' },
      { owner: 'sub:r', key: 'tools' },
    ]);
    const g1 = removeNode(g, 'sub:r');
    expect(g1.emptySections).toEqual([{ owner: 'agent', key: 'tools' }]);
  });
});

describe('duplicateNode', () => {
  const layout: CanvasLayout = {
    schemaVersion: 1,
    nodes: { 'tool:http': { x: 10, y: 20 } },
    notes: [{ id: 'n1', x: 0, y: 0, text: 't' }],
  };
  const g = specToGraph(minimalSpec({ tools: [{ builtin: 'http' }] }), layout);

  it('refuses the root agent and notes', () => {
    expect(duplicateNode(g, 'agent')).toStrictEqual({ graph: g, nodeId: undefined });
    expect(duplicateNode(g, 'note:n1')).toStrictEqual({ graph: g, nodeId: undefined });
  });

  it('copies a tool at +40/+40 under a deduped id', () => {
    const r = duplicateNode(g, 'tool:http');
    expect(r.nodeId).toBe('tool:http#2');
    const clone = nodeById(r.graph, 'tool:http#2');
    expect(clone.position).toStrictEqual({ x: 50, y: 60 });
    expect(clone.owner).toBe('agent');
    expect(toolItem(r.graph, 'tool:http#2')).toStrictEqual(toolItem(g, 'tool:http'));
  });
});

describe('moveNode / setNodeData / setCollapsed', () => {
  const g = specToGraph(treeSpec());

  it('moves a node to a new position', () => {
    const g1 = moveNode(g, 'tool:http', { x: 7, y: 8 });
    expect(nodeById(g1, 'tool:http').position).toStrictEqual({ x: 7, y: 8 });
    expect(nodeById(g, 'tool:http').position).not.toStrictEqual({ x: 7, y: 8 });
  });

  it('replaces a node\'s whole data object', () => {
    const data: GraphNode['data'] = { item: { builtin: 'current_date' } };
    const g1 = setNodeData<'tool'>(g, 'tool:http', data);
    expect(toolItem(g1, 'tool:http')).toStrictEqual({ builtin: 'current_date' });
  });

  it('sets collapsed on a group node', () => {
    const g1 = setCollapsed(g, 'sub:r', true);
    expect(nodeById(g1, 'sub:r').collapsed).toBe(true);
    const r = graphToSpec(g1);
    expect(r.layout.nodes['sub:r'].collapsed).toBe(true);
  });

  it('round-trips collapsed through layout.json back onto the node', () => {
    const g = specToGraph(
      minimalSpec({
        subagents: {
          research: inlineAgent({ name: 'research' }),
        },
      }),
    );
    const r = graphToSpec(setCollapsed(g, 'sub:research', true));
    expect(r.layout.nodes['sub:research']).toMatchObject({ collapsed: true });
    const g2 = specToGraph(r.spec, r.layout);
    expect(nodeById(g2, 'sub:research').collapsed).toBe(true);
  });
});

describe('palette create (C04 subagent entries)', () => {
  const g0 = specToGraph(minimalSpec());
  const entries = Object.values(KIND_VIEWS).flatMap((view) => view?.palette ?? []);
  const inline = entries.find((e) => e.id === 'subagent-inline');
  const ref = entries.find((e) => e.id === 'subagent-ref');
  const remote = entries.find((e) => e.id === 'subagent-remote');

  it('registers all three entries under the Agents group', () => {
    for (const entry of [inline, ref, remote]) {
      expect(entry).toBeDefined();
      expect(entry?.group).toBe('Agents');
    }
    expect(inline?.kind).toBe('agent');
    expect(ref?.kind).toBe('subagent');
    expect(remote?.kind).toBe('subagent');
  });

  it('names the first subagent "helper" and the second "helper-2"', () => {
    const first = inline!.create(g0, 'agent');
    expect((first.data as AgentNodeData).subagentKey).toBe('helper');
    const g1 = addNode(g0, first, AT, 'agent').graph;
    const second = ref!.create(g1, 'agent');
    expect((second.data as SubagentNodeData).key).toBe('helper-2');
  });

  it('names a remote subagent "remote"', () => {
    expect((remote!.create(g0, 'agent').data as SubagentNodeData).key).toBe('remote');
    expect((remote!.create(g0, 'agent').data as SubagentNodeData).item).toStrictEqual({
      remote: { url: '', description: '' },
    });
  });

  it('seeds the inline agent\'s fields from its key and the owner\'s model', () => {
    const data = inline!.create(g0, 'agent').data as AgentNodeData;
    expect(data.fields).toMatchObject({
      name: 'helper',
      description: '',
      model: 'mock/mock-1',
      instructions: '',
    });
    expect(data.extra).toStrictEqual({});
    const added = addNode(g0, inline!.create(g0, 'agent'), AT, 'agent');
    expect(added.nodeId).toBe('sub:helper');
    expect(graphToSpec(added.graph).spec.subagents?.['helper']).toMatchObject({ inline: { name: 'helper' } });
  });
});

describe('palette create (C06 tool entries)', () => {
  const g0 = specToGraph(minimalSpec());
  const entries = Object.values(KIND_VIEWS).flatMap((view) => view?.palette ?? []);
  const tool = entries.find((e) => e.id === 'tool');
  const openapi = entries.find((e) => e.id === 'tool-openapi');
  const integration = entries.find((e) => e.id === 'tool-integration');

  it('registers all three entries under the Capabilities group', () => {
    for (const entry of [tool, openapi, integration]) {
      expect(entry).toBeDefined();
      expect(entry?.group).toBe('Capabilities');
      expect(entry?.kind).toBe('tool');
    }
  });

  it('creates the empty item each entry describes', () => {
    expect(tool!.create(g0, 'agent').data).toStrictEqual({ item: { builtin: '' } });
    expect(openapi!.create(g0, 'agent').data).toStrictEqual({ item: { openapi: { url: '' } } });
    expect(integration!.create(g0, 'agent').data).toStrictEqual({
      item: { integration: 'github', credentials: {} },
    });
  });

  it('names two built-in creates tool:new and tool:new#2', () => {
    const first = addNode(g0, tool!.create(g0, 'agent'), AT, 'agent');
    expect(first.nodeId).toBe('tool:new');
    const second = addNode(first.graph, tool!.create(first.graph, 'agent'), AT, 'agent');
    expect(second.nodeId).toBe('tool:new#2');
  });
});

describe('reownNode', () => {
  const g = specToGraph(treeSpec());

  it('moves a capability node into a group at {x:24,y:48} without rekeying', () => {
    const g1 = reownNode(g, 'tool:http', 'sub:r');
    const moved = nodeById(g1, 'tool:http');
    expect(moved.owner).toBe('sub:r');
    expect(moved.id).toBe('tool:http');
    expect(moved.position).toStrictEqual({ x: 24, y: 48 });
    const r = graphToSpec(g1);
    const inline = r.spec.subagents?.['r'] as { inline: { tools: unknown[] } };
    expect(inline.inline.tools).toContainEqual({ builtin: 'http' });
    expect(r.spec.tools).toBeUndefined();
  });

  it('restores the absolute position when a node leaves a group', () => {
    const sub = nodeById(g, 'sub:r');
    const tool = nodeById(g, 'sub:r/tool:x');
    const expected = { x: sub.position.x + tool.position.x, y: sub.position.y + tool.position.y };
    const g1 = reownNode(g, 'sub:r/tool:x', 'agent');
    expect(nodeById(g1, 'sub:r/tool:x').position).toStrictEqual(expected);
    expect(nodeById(g1, 'sub:r/tool:x').owner).toBe('agent');
  });
});

describe('connectNodes', () => {
  const g = specToGraph(treeSpec());

  it('agent → capability re-owns the capability', () => {
    const result = connectNodes(g, 'agent', 'sub:r/tool:x');
    expect(result.ok).toBe(true);
    if (result.ok) expect(nodeById(result.graph, 'sub:r/tool:x').owner).toBe('agent');
  });

  it('returns canConnect\'s refusal verbatim', () => {
    expect(connectNodes(g, 'tool:http', 'agent')).toStrictEqual({
      ok: false,
      reason: "Can't connect tool → agent",
    });
    expect(connectNodes(g, 'agent', 'tool:http')).toStrictEqual({
      ok: false,
      reason: 'Already attached to this agent',
    });
  });

  it('refuses unknown endpoints', () => {
    expect(connectNodes(g, 'ghost', 'agent').ok).toBe(false);
  });
});

describe('immutability', () => {
  it('every mutation returns a new graph and never mutates a deep-frozen input', () => {
    const g = deepFreeze(specToGraph(treeSpec()));
    const results: Array<unknown> = [
      addNode(g, { kind: 'tool', data: { item: { builtin: 'z' } } }, AT, 'agent'),
      removeNode(g, 'tool:http'),
      duplicateNode(g, 'tool:http'),
      moveNode(g, 'tool:http', { x: 1, y: 1 }),
      setNodeData<'tool'>(g, 'tool:http', { item: { builtin: 'z' } }),
      patchNode(g, 'tool:http', { approval: 'always' }),
      setCollapsed(g, 'sub:r', true),
      reownNode(g, 'tool:http', 'sub:r'),
      connectNodes(g, 'agent', 'sub:r/tool:x'),
    ];
    for (const result of results) {
      const resultGraph = typeof result === 'object' && result !== null && 'graph' in result ? result.graph : result;
      expect(resultGraph).not.toBe(g);
    }
    expect(g.nodes.map((n) => n.id)).toEqual([
      'agent',
      'tool:http',
      'sub:r',
      'sub:r/tool:x',
      'sub:r/sub:s',
      'sub:r/sub:s/tool:y',
    ]);
  });
});

/* --- mutation round-trip property test --- */

/** Section kinds the property test adds (flow is C15's; notes are not a section). */
const ADD_KINDS: readonly NodeKind[] = [
  'tool', 'mcp', 'skill', 'memory', 'subagent', 'agent', 'handoff',
  'guardrail', 'permission', 'hook', 'trigger', 'abort', 'output',
];

/** Ids of every live agent node (owner candidates). */
function agentIds(g: Graph): string[] {
  return g.nodes.filter((n) => n.kind === 'agent' && n.proposed !== 'remove').map((n) => n.id);
}

/** Keys of the owner's `subagents` entries: `data.key` for refs, `data.subagentKey` for inline agents. */
function siblingSubagentKeys(g: Graph, owner: string): string[] {
  return g.nodes
    .filter((n) => n.owner === owner && (n.kind === 'subagent' || (n.kind === 'agent' && n.owner !== null)))
    .map((n) =>
      n.kind === 'subagent' ? (n.data as SubagentNodeData).key : ((n.data as AgentNodeData).subagentKey ?? '')
    );
}

/** Keys of the owner's `mcpServers` entries. */
function siblingMcpKeys(g: Graph, owner: string): string[] {
  return g.nodes
    .filter((n) => n.owner === owner && n.kind === 'mcp')
    .map((n) => (n.data as McpNodeData).key);
}

/** A minimal valid `data` for `kind` owned by `owner`; record keys are unique so graphToSpec cannot throw. */
function minimalData(g: Graph, kind: NodeKind, owner: string): GraphNode['data'] {
  switch (kind) {
    case 'tool':
      return { item: { builtin: 'http' } };
    case 'mcp':
      return { key: uniqueName('m', siblingMcpKeys(g, owner)), item: { command: 'x' } };
    case 'skill':
      return { item: { dir: 'skills/a' } };
    case 'memory':
      return { item: { name: 'm', scope: 'session', provider: { type: 'in-memory' } } };
    case 'subagent':
      return { key: uniqueName('s', siblingSubagentKeys(g, owner)), item: { ref: 'agents/x.yaml' } };
    case 'agent': {
      const key = uniqueName('s', siblingSubagentKeys(g, owner));
      return {
        fields: { name: key, description: 'd', model: 'mock/mock-1', instructions: 'x' },
        extra: {},
        subagentKey: key,
      };
    }
    case 'handoff':
      return { item: { agent: 'b' } };
    case 'guardrail':
      return { item: { id: 'g1', name: 'max-length', on: 'input' } };
    case 'permission':
      return { item: { id: 'p1', tool: '*', action: 'allow' } };
    case 'hook':
      return { item: { id: 'h1', inline: { name: 'n', point: 'preToolCall', code: 'return ctx;' } } };
    case 'trigger':
      return { item: { id: 't1', type: 'chat' } };
    case 'abort':
      return { item: { id: 'a1', triggerId: 't1', when: 'true', match: 'true', scope: 'both' } };
    case 'output':
      return { item: { jsonSchema: { type: 'object' } } };
    default:
      throw new Error(`no minimal data for ${kind}`);
  }
}

/** Whether `owner` already has an output node (an agent can have only one). */
function hasOutput(g: Graph, owner: string): boolean {
  return g.nodes.some((n) => n.kind === 'output' && n.owner === owner && n.proposed !== 'remove');
}

/** A random valid add: a random section kind, a fitting owner, minimal data. */
function randomAdd(rng: Rng, g: Graph): { kind: NodeKind; data: GraphNode['data']; owner: string } {
  let kind = pick(rng, ADD_KINDS);
  if (kind === 'output' && agentIds(g).every((id) => hasOutput(g, id))) kind = 'tool';
  const owner = ROOT_ONLY_KINDS.has(kind)
    ? 'agent'
    : kind === 'output'
      ? pick(rng, agentIds(g).filter((id) => !hasOutput(g, id)))
      : pick(rng, agentIds(g));
  return { kind, owner, data: minimalData(g, kind, owner) };
}

/** One random mutation from the ticket's list. */
function randomMutation(rng: Rng, g: Graph): Graph {
  const op = pick(rng, ['add', 'remove', 'move', 'patch'] as const);
  switch (op) {
    case 'add': {
      const { kind, data, owner } = randomAdd(rng, g);
      return addNode(g, { kind, data }, { x: int(rng, -500, 500), y: int(rng, -500, 500) }, owner).graph;
    }
    case 'remove': {
      const removable = g.nodes.filter((n) => n.id !== 'agent');
      return removable.length === 0 ? g : removeNode(g, pick(rng, removable).id);
    }
    case 'move':
      return moveNode(g, pick(rng, g.nodes).id, { x: int(rng, -500, 500), y: int(rng, -500, 500) });
    case 'patch': {
      const candidates = g.nodes.filter((n) => n.kind !== 'note');
      return patchNode(g, pick(rng, candidates).id, { description: 'd' + int(rng, 0, 99) });
    }
  }
}

const SEEDS = Array.from({ length: 100 }, (_, i) => i + 1);

describe.each(SEEDS)('mutation round trip, seed %i', (seed) => {
  const rng = mulberry32(seed);
  let g = specToGraph(arbSpec(rng));
  for (let i = 0; i < 10; i += 1) g = randomMutation(rng, g);
  const r1 = graphToSpec(g);
  const g2 = specToGraph(r1.spec, r1.layout);
  const r2 = graphToSpec(g2, r1.spec);

  it('spec and layout are identical after a spec→graph→spec cycle', () => {
    expect(r2.spec).toStrictEqual(r1.spec);
    expect(r2.layout).toStrictEqual(r1.layout);
  });
});
