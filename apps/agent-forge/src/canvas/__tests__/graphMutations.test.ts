import { describe, expect, it } from 'vitest';
import {
  addNode,
  connectNodes,
  duplicateNode,
  moveNode,
  removeEdge,
  removeNode,
  renameNode,
  updateNodeData,
} from '../graphMutations';
import type { AgentGraphSpec } from '../../graph/types';

function baseGraph(): AgentGraphSpec {
  return {
    version: 1,
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        position: { x: 0, y: 0 },
        label: 'Trigger',
        data: { trigger: { type: 'input' } },
      },
      {
        id: 'llm-1',
        type: 'llm',
        position: { x: 200, y: 0 },
        label: 'agent',
        data: { name: 'agent', prompt: 'hi', provider: { type: 'mock', model: 'mock-1' } },
      },
      {
        id: 'tool-1',
        type: 'tool',
        position: { x: 400, y: 0 },
        label: 'http',
        data: { toolName: 'http' },
      },
    ],
    edges: [
      { id: 'e1', source: 'trigger-1', target: 'llm-1' },
      { id: 'e2', source: 'llm-1', target: 'tool-1' },
    ],
  };
}

describe('addNode', () => {
  it('appends a new node of the given type with default data at the given position', () => {
    const g = addNode(baseGraph(), 'output', { x: 600, y: 0 });
    expect(g.nodes).toHaveLength(4);
    const added = g.nodes[3];
    expect(added.type).toBe('output');
    expect(added.position).toEqual({ x: 600, y: 0 });
    expect(g.edges).toHaveLength(2); // adding a node never adds edges
  });

  it('does not mutate the input graph', () => {
    const original = baseGraph();
    const originalNodeCount = original.nodes.length;
    addNode(original, 'output', { x: 0, y: 0 });
    expect(original.nodes).toHaveLength(originalNodeCount);
  });
});

describe('removeNode', () => {
  it('removes the node and any edge touching it', () => {
    const g = removeNode(baseGraph(), 'llm-1');
    expect(g.nodes.map((n) => n.id)).toEqual(['trigger-1', 'tool-1']);
    expect(g.edges).toEqual([]);
  });

  it('is a no-op for an unknown node id', () => {
    const g = removeNode(baseGraph(), 'ghost');
    expect(g.nodes).toHaveLength(3);
    expect(g.edges).toHaveLength(2);
  });
});

describe('duplicateNode', () => {
  it('clones a node with a new id, offset position, no inherited edges', () => {
    const g = duplicateNode(baseGraph(), 'tool-1');
    expect(g.nodes).toHaveLength(4);
    const clone = g.nodes[3];
    expect(clone.id).not.toBe('tool-1');
    expect(clone.type).toBe('tool');
    expect(clone.position).toEqual({ x: 440, y: 40 });
    expect(g.edges.some((e) => e.source === clone.id || e.target === clone.id)).toBe(false);
  });

  it('deep-clones data so editing the clone does not affect the source', () => {
    const g = duplicateNode(baseGraph(), 'tool-1');
    const clone = g.nodes[3];
    expect(clone.type).toBe('tool');
    if (clone.type === 'tool') {
      expect(clone.data).not.toBe(baseGraph().nodes[2].data);
    }
  });

  it('is a no-op for an unknown node id', () => {
    const g = duplicateNode(baseGraph(), 'ghost');
    expect(g.nodes).toHaveLength(3);
  });
});

describe('renameNode', () => {
  it('renames a node label', () => {
    const g = renameNode(baseGraph(), 'tool-1', 'HTTP call');
    expect(g.nodes.find((n) => n.id === 'tool-1')?.label).toBe('HTTP call');
  });

  it('also updates data.name for an llm node', () => {
    const g = renameNode(baseGraph(), 'llm-1', 'renamed-agent');
    const llm = g.nodes.find((n) => n.id === 'llm-1');
    expect(llm?.label).toBe('renamed-agent');
    expect(llm?.type === 'llm' && llm.data.name).toBe('renamed-agent');
  });
});

describe('moveNode', () => {
  it('updates a node position', () => {
    const g = moveNode(baseGraph(), 'tool-1', { x: 999, y: 111 });
    expect(g.nodes.find((n) => n.id === 'tool-1')?.position).toEqual({ x: 999, y: 111 });
  });
});

describe('updateNodeData', () => {
  it('shallow-merges a data patch', () => {
    const g = updateNodeData(baseGraph(), 'tool-1', { toolName: 'day-name' });
    const tool = g.nodes.find((n) => n.id === 'tool-1');
    expect(tool?.type === 'tool' && tool.data.toolName).toBe('day-name');
  });
});

describe('connectNodes', () => {
  it('rejects a connection that runs against the pipeline direction (tool -> llm)', () => {
    const result = connectNodes(baseGraph(), 'tool-1', 'llm-1');
    expect(result.ok).toBe(false);
  });

  it('accepts a compatible connection (llm -> tool)', () => {
    const g = removeNode(baseGraph(), 'tool-1'); // drop the pre-existing tool node
    const withTool = addNode(g, 'tool', { x: 400, y: 0 });
    const newToolId = withTool.nodes[withTool.nodes.length - 1].id;
    const result = connectNodes(withTool, 'llm-1', newToolId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph.edges.some((e) => e.source === 'llm-1' && e.target === newToolId)).toBe(true);
    }
  });

  it('rejects an incompatible connection (trigger -> trigger)', () => {
    const g = addNode(baseGraph(), 'trigger', { x: 0, y: 200 });
    const secondTrigger = g.nodes[g.nodes.length - 1].id;
    const result = connectNodes(g, 'trigger-1', secondTrigger);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a valid pipeline connection/);
  });

  it('rejects connecting a node to itself', () => {
    const result = connectNodes(baseGraph(), 'llm-1', 'llm-1');
    expect(result.ok).toBe(false);
  });

  it('rejects an already-existing connection', () => {
    const result = connectNodes(baseGraph(), 'trigger-1', 'llm-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/already connected/);
  });

  it('rejects a connection referencing an unknown node', () => {
    const result = connectNodes(baseGraph(), 'ghost', 'llm-1');
    expect(result.ok).toBe(false);
  });
});

describe('removeEdge', () => {
  it('removes a single edge by id', () => {
    const g = removeEdge(baseGraph(), 'e1');
    expect(g.edges).toEqual([{ id: 'e2', source: 'llm-1', target: 'tool-1' }]);
  });
});
