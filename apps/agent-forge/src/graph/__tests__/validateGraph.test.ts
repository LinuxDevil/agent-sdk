import { describe, expect, it } from 'vitest';
import { validateGraph } from '../validateGraph';
import type { AgentGraphSpec } from '../types';

function graph(overrides: Partial<AgentGraphSpec>): AgentGraphSpec {
  return {
    version: 1,
    nodes: [
      {
        id: 'llm-1',
        type: 'llm',
        position: { x: 0, y: 0 },
        label: 'agent',
        data: { name: 'agent', prompt: 'hi', provider: { type: 'mock', model: 'mock-1' } },
      },
    ],
    edges: [],
    ...overrides,
  };
}

describe('validateGraph', () => {
  it('accepts a minimal valid graph (single llm node, no edges)', () => {
    const result = validateGraph(graph({}));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('flags a dangling edge referencing a missing node', () => {
    const g = graph({ edges: [{ id: 'e1', source: 'llm-1', target: 'ghost' }] });
    const result = validateGraph(g);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ edgeId: 'e1', message: expect.stringContaining("missing target node 'ghost'") })
    );
  });

  it('flags a dangling edge with a missing source node', () => {
    const g = graph({ edges: [{ id: 'e1', source: 'ghost', target: 'llm-1' }] });
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ edgeId: 'e1', message: expect.stringContaining("missing source node 'ghost'") })
    );
  });

  it('detects a 2-node cycle', () => {
    const g = graph({
      nodes: [
        ...graph({}).nodes,
        { id: 'tool-1', type: 'tool', position: { x: 0, y: 0 }, label: 't', data: { toolName: 'http' } },
      ],
      edges: [
        { id: 'e1', source: 'llm-1', target: 'tool-1' },
        { id: 'e2', source: 'tool-1', target: 'llm-1' },
      ],
    });
    const result = validateGraph(g);
    expect(result.valid).toBe(false);
    const cycleNodeIds = result.errors.filter((e) => e.message.includes('cycle')).map((e) => e.nodeId);
    expect(cycleNodeIds).toEqual(expect.arrayContaining(['llm-1', 'tool-1']));
  });

  it('detects a self-loop cycle', () => {
    const g = graph({ edges: [{ id: 'e1', source: 'llm-1', target: 'llm-1' }] });
    const result = validateGraph(g);
    expect(result.errors.some((e) => e.message.includes('cycle'))).toBe(true);
  });

  it('requires an llm node to have name/prompt/provider.type/provider.model', () => {
    const g = graph({
      nodes: [
        {
          id: 'llm-1',
          type: 'llm',
          position: { x: 0, y: 0 },
          label: '',
          data: { name: '', prompt: '', provider: { type: '', model: '' } },
        },
      ],
    });
    const result = validateGraph(g);
    const messages = result.errors.map((e) => e.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("missing required field 'name'"),
        expect.stringContaining("missing required field 'prompt'"),
        expect.stringContaining("missing required field 'provider.type'"),
        expect.stringContaining("missing required field 'provider.model'"),
      ])
    );
  });

  it('requires a tool node to have a toolName', () => {
    const g = graph({
      nodes: [
        ...graph({}).nodes,
        { id: 'tool-1', type: 'tool', position: { x: 0, y: 0 }, label: '', data: { toolName: '' } },
      ],
    });
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ nodeId: 'tool-1', message: expect.stringContaining("missing required field 'toolName'") })
    );
  });

  it('requires a trigger node to have trigger.type', () => {
    const g = graph({
      nodes: [
        ...graph({}).nodes,
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 0, y: 0 },
          label: '',
          data: { trigger: { type: '' } },
        },
      ],
    });
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        nodeId: 'trigger-1',
        message: expect.stringContaining("missing required field 'trigger.type'"),
      })
    );
  });

  it('flags duplicate node ids', () => {
    const single = graph({}).nodes[0];
    const g = graph({ nodes: [single, single] });
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ nodeId: 'llm-1', message: expect.stringContaining('Duplicate node id') })
    );
  });

  it('flags an edge connecting incompatible node types (trigger -> trigger)', () => {
    const g = graph({
      nodes: [
        ...graph({}).nodes,
        { id: 'trigger-1', type: 'trigger', position: { x: 0, y: 0 }, label: 't1', data: { trigger: { type: 'input' } } },
        { id: 'trigger-2', type: 'trigger', position: { x: 0, y: 0 }, label: 't2', data: { trigger: { type: 'input' } } },
      ],
      edges: [{ id: 'e1', source: 'trigger-1', target: 'trigger-2' }],
    });
    const result = validateGraph(g);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        edgeId: 'e1',
        message: expect.stringContaining("connects incompatible node types 'trigger' -> 'trigger'"),
      })
    );
  });

  it('flags zero llm nodes and more than one llm node', () => {
    expect(validateGraph({ version: 1, nodes: [], edges: [] }).errors).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('found none') })
    );

    const twoLlm = graph({
      nodes: [
        ...graph({}).nodes,
        {
          id: 'llm-2',
          type: 'llm',
          position: { x: 0, y: 0 },
          label: 'agent2',
          data: { name: 'agent2', prompt: 'hi', provider: { type: 'mock', model: 'mock-1' } },
        },
      ],
    });
    const result = validateGraph(twoLlm);
    expect(result.errors.filter((e) => e.message.includes('found 2'))).toHaveLength(2);
  });
});
