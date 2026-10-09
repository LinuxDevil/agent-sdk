import { describe, it, expect } from 'vitest';
import type { NodeChange } from '@xyflow/react';
import { NODE_TYPES, flowNodeType, miniMapNodeClassName } from '../AgentNode';
import { applyDimensionChanges } from '../../components/CanvasArea';
import type { AgentGraphNodeType } from '../../graph/types';

const GRAPH_TYPES: AgentGraphNodeType[] = ['trigger', 'llm', 'tool', 'approval', 'output', 'router'];
const REACT_FLOW_BUILT_INS = ['input', 'output', 'default', 'group'];

describe('React Flow node types (Eve DUI-F22)', () => {
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

describe('applyDimensionChanges (Eve DUI-F22)', () => {
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
