import { describe, it, expect } from 'vitest';
import type { NodeChange } from '@xyflow/react';
import { NODE_TYPES, flowNodeType, miniMapNodeClassName } from '../AgentNode';
import { applyDimensionChanges, toRfEdges } from '../../components/CanvasArea';
import { specToGraph } from '../../graph/specToGraph';
import type { AgentGraphNodeType } from '../../graph/types';

const GRAPH_TYPES: AgentGraphNodeType[] = ['trigger', 'llm', 'tool', 'approval', 'output', 'router'];
const REACT_FLOW_BUILT_INS = ['input', 'output', 'default', 'group'];

describe('React Flow node types', () => {
  it('never reuse a React Flow built-in type, so no built-in node chrome is applied', () => {
    for (const type of GRAPH_TYPES) {
      expect(REACT_FLOW_BUILT_INS).not.toContain(flowNodeType(type));
      expect(NODE_TYPES[flowNodeType(type)]).toBeDefined();
    }
    for (const builtIn of REACT_FLOW_BUILT_INS) expect(NODE_TYPES[builtIn]).toBeUndefined();
  });

  it('gives each MiniMap node its graph type as a class', () => {
    const node = { data: { graphNode: { type: 'output' } } };
    expect(miniMapNodeClassName(node)).toBe('minimap-node-output');
    expect(miniMapNodeClassName({ data: {} })).toBe('');
  });
});

describe('applyDimensionChanges', () => {
  it('records measured sizes so the MiniMap can draw the nodes', () => {
    const changes: NodeChange[] = [
      { type: 'dimensions', id: 'a', dimensions: { width: 190, height: 80 } },
      { type: 'select', id: 'a', selected: true },
    ];
    expect(applyDimensionChanges({}, changes)).toEqual({ a: { width: 190, height: 80 } });
  });

  it('returns the same object when nothing changed, so it does not re-render', () => {
    const prev = { a: { width: 190, height: 80 } };
    expect(applyDimensionChanges(prev, [{ type: 'dimensions', id: 'a', dimensions: { width: 190, height: 80 } }])).toBe(prev);
    expect(applyDimensionChanges(prev, [{ type: 'remove', id: 'b' }])).toBe(prev);
  });
});

describe('toRfEdges', () => {
  const graph = specToGraph({ name: 'a', prompt: 'p', provider: { type: 'mock', model: 'mock-1' }, tools: ['http'], triggers: [{ type: 'input' }] });
  const llm = graph.nodes.find((n) => n.type === 'llm')!;

  it('draws smoothstep edges with a closed arrow, still while nothing runs', () => {
    const edges = toRfEdges(graph);
    expect(edges).toHaveLength(graph.edges.length);
    for (const edge of edges) {
      expect(edge.type).toBe('gapped');
      expect(edge.selected).toBe(false);
      expect(edge.deletable).toBe(false);
      expect(edge.animated).toBe(false);
      expect(edge.markerEnd).toMatchObject({ type: 'arrowclosed', color: 'var(--text-faint)' });
    }
  });

  it("animates the edges leaving a running node in the accent colour", () => {
    const edges = toRfEdges(graph, { [llm.id]: 'running' });
    const fromLlm = edges.filter((e) => e.source === llm.id);
    expect(fromLlm.length).toBeGreaterThan(0);
    for (const edge of fromLlm) {
      expect(edge.animated).toBe(true);
      expect(edge.className).toBe('edge-running');
      expect(edge.markerEnd).toMatchObject({ color: 'var(--accent)' });
    }
    for (const edge of edges.filter((e) => e.source !== llm.id)) expect(edge.animated).toBe(false);
  });

  it('marks only the selected edge as selected', () => {
    const [first, ...rest] = graph.edges;
    const edges = toRfEdges(graph, {}, first.id);
    expect(edges.find((e) => e.id === first.id)?.selected).toBe(true);
    for (const edge of rest) expect(edges.find((e) => e.id === edge.id)?.selected).toBe(false);
  });
});
