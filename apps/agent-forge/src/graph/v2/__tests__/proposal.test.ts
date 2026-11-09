import { describe, expect, it } from 'vitest';
import type { CanvasLayout } from '../../../../shared/wireTypes';
import { mergeProposal, proposalCounts } from '../proposal';
import { graphToSpec } from '../graphToSpec';
import { setNodeData } from '../mutations';
import { specToGraph } from '../specToGraph';
import type { AgentSpecV2 } from '../specTypes';
import type { Graph, GraphNode } from '../types';

/** The ticket's worked example: one tool, one guardrail, a mock model. */
const BASE = {
  version: 2,
  name: 'bot',
  model: 'mock/mock-1',
  instructions: 'x',
  tools: [{ builtin: 'http' }],
  guardrails: [{ id: 'g1', name: 'max-length', on: 'input' }],
} as unknown as AgentSpecV2;

const spec = (over: Record<string, unknown> = {}): AgentSpecV2 => ({ ...BASE, ...over }) as AgentSpecV2;

/** A layout recording every non-note node's current position (what AppState passes). */
function layoutOf(graph: Graph): CanvasLayout {
  const nodes: CanvasLayout['nodes'] = {};
  for (const n of graph.nodes) {
    if (n.kind === 'note') continue;
    nodes[n.id] = { x: n.position.x, y: n.position.y, ...(n.collapsed !== undefined ? { collapsed: n.collapsed } : {}) };
  }
  return { schemaVersion: 1, nodes, notes: [] };
}

const node = (graph: Graph, id: string): GraphNode => graph.nodes.find((n) => n.id === id)!;
const proposedOf = (graph: Graph, id: string) => node(graph, id).proposed;

describe('mergeProposal classification', () => {
  it('marks a spec-only node proposed:add, keeps shared nodes unmarked', () => {
    const current = specToGraph(spec());
    const proposed = spec({ tools: [{ builtin: 'http' }, { builtin: 'web_fetch' }] });
    const merged = mergeProposal(current, proposed, layoutOf(current));

    expect(proposedOf(merged, 'tool:web_fetch')).toBe('add');
    expect(proposedOf(merged, 'tool:http')).toBeUndefined();
    expect(proposedOf(merged, 'agent')).toBeUndefined();
    expect(proposedOf(merged, 'guard:g1')).toBeUndefined();
    expect(proposalCounts(merged)).toEqual({ added: 1, removed: 0, edited: 0 });
  });

  it('marks a current-only node proposed:remove', () => {
    const current = specToGraph(spec());
    const proposed = spec({ guardrails: [] });
    const merged = mergeProposal(current, proposed, layoutOf(current));

    expect(proposedOf(merged, 'guard:g1')).toBe('remove');
    expect(proposalCounts(merged)).toEqual({ added: 0, removed: 1, edited: 0 });
  });

  it('marks a node whose data differs proposed:edit and keeps its position', () => {
    const layout: CanvasLayout = {
      schemaVersion: 1,
      nodes: { agent: { x: 40, y: 60 }, 'tool:http': { x: 300, y: 60 }, 'guard:g1': { x: 300, y: 200 } },
      notes: [],
    };
    const current = specToGraph(spec(), layout);
    const proposed = spec({ model: 'openai/gpt-5' });
    const merged = mergeProposal(current, proposed, layoutOf(current));

    const agent = node(merged, 'agent');
    expect(agent.proposed).toBe('edit');
    expect(agent.position).toEqual({ x: 40, y: 60 });
    // The edit node carries the PROPOSED data.
    expect((agent.data as { fields: { model?: string } }).fields.model).toBe('openai/gpt-5');
    expect(proposedOf(merged, 'tool:http')).toBeUndefined();
    expect(node(merged, 'tool:http').position).toEqual({ x: 300, y: 60 });
  });

  it('leaves an identical proposal unmarked', () => {
    const current = specToGraph(spec());
    const merged = mergeProposal(current, spec(), layoutOf(current));
    expect(merged.nodes.every((n) => n.proposed === undefined)).toBe(true);
    expect(merged.nodes.map((n) => n.id)).toEqual(current.nodes.map((n) => n.id));
  });
});

describe('mergeProposal layout and order', () => {
  it('keeps positions for shared ids and marks new ids unplaced', () => {
    const layout: CanvasLayout = {
      schemaVersion: 1,
      nodes: { agent: { x: 10, y: 20 }, 'tool:http': { x: 210, y: 20 }, 'guard:g1': { x: 210, y: 160 } },
      notes: [],
    };
    const current = specToGraph(spec(), layout);
    const proposed = spec({ tools: [{ builtin: 'http' }, { builtin: 'web_fetch' }] });
    const merged = mergeProposal(current, proposed, layoutOf(current));

    expect(node(merged, 'agent').position).toEqual({ x: 10, y: 20 });
    expect(node(merged, 'tool:http').position).toEqual({ x: 210, y: 20 });
    expect(node(merged, 'tool:web_fetch').proposed).toBe('add');
    expect(merged.unplaced).toContain('tool:web_fetch');
    expect(merged.unplaced).not.toContain('tool:http');
  });

  it('inserts a removed node after its previous sibling in the current order', () => {
    const three = spec({
      tools: [{ builtin: 'http' }, { builtin: 'web_fetch' }, { builtin: 'current_date' }],
    });
    const current = specToGraph(three);
    const proposed = spec({
      tools: [{ builtin: 'http' }, { builtin: 'current_date' }],
    });
    const merged = mergeProposal(current, proposed, layoutOf(current));

    const ids = merged.nodes.map((n) => n.id);
    expect(ids.indexOf('tool:web_fetch')).toBe(ids.indexOf('tool:http') + 1);
    expect(ids.indexOf('tool:web_fetch')).toBeLessThan(ids.indexOf('tool:current_date'));
    expect(proposedOf(merged, 'tool:web_fetch')).toBe('remove');
  });

  it('carries notes over untouched and keeps the viewport', () => {
    const current = specToGraph(spec());
    current.nodes.push({
      id: 'note:n1',
      kind: 'note',
      owner: null,
      position: { x: 5, y: 6 },
      data: { text: 'hi' },
    });
    current.viewport = { x: 1, y: 2, zoom: 0.8 };
    const merged = mergeProposal(current, spec({ model: 'openai/gpt-5' }), layoutOf(current));

    const note = node(merged, 'note:n1');
    expect(note.kind).toBe('note');
    expect(note.proposed).toBeUndefined();
    expect(note.position).toEqual({ x: 5, y: 6 });
    expect(merged.viewport).toEqual({ x: 1, y: 2, zoom: 0.8 });
  });
});

describe('mergeProposal rekeying', () => {
  it('an unsaved MCP rename is an edit, not remove + add', () => {
    // Simulate the unsaved rename: the node keeps its old id while its data
    // (and the derived spec) already say 'new'.
    const withOld = specToGraph(spec({ mcpServers: { old: { command: 'npx' } } }));
    const renamed = setNodeData(withOld, 'mcp:old', {
      key: 'new',
      item: { command: 'npx' },
    } as never);
    const { nodeIdMap } = graphToSpec(renamed);
    expect(nodeIdMap['mcp:old']).toBe('mcp:new');

    const proposed = graphToSpec(renamed).spec;
    const merged = mergeProposal(renamed, proposed, layoutOf(renamed), nodeIdMap);

    const mcpNodes = merged.nodes.filter((n) => n.kind === 'mcp');
    expect(mcpNodes).toHaveLength(1);
    expect(mcpNodes[0].id).toBe('mcp:new');
    expect(mcpNodes[0].proposed).toBeUndefined();
    expect(proposalCounts(merged)).toEqual({ added: 0, removed: 0, edited: 0 });
  });
});

describe('mergeProposal round-trip', () => {
  it('graphToSpec(merged).spec equals the proposed spec (add + remove + edit)', () => {
    const current = specToGraph(spec());
    const proposed = spec({
      model: 'openai/gpt-5',
      tools: [{ builtin: 'http' }, { builtin: 'web_fetch' }],
      guardrails: [],
    });
    const merged = mergeProposal(current, proposed, layoutOf(current));
    expect(proposalCounts(merged)).toEqual({ added: 1, removed: 1, edited: 1 });
    expect(graphToSpec(merged).spec).toStrictEqual(proposed);
  });

  it('does not mutate the current graph', () => {
    const current = specToGraph(spec());
    const before = current.nodes.map((n) => ({ ...n, proposed: n.proposed }));
    mergeProposal(current, spec({ model: 'openai/gpt-5' }), layoutOf(current));
    expect(current.nodes.map((n) => n.proposed)).toEqual(before.map((n) => n.proposed));
    expect(current.nodes.every((n) => n.proposed === undefined)).toBe(true);
  });
});
