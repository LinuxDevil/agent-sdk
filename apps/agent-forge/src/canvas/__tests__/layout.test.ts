import { describe, expect, it } from 'vitest';
import { autoLayout } from '../layout';
import type { AgentGraphSpec } from '../../graph/types';

function graph(): AgentGraphSpec {
  return {
    version: 1,
    nodes: [
      { id: 'trigger-1', type: 'trigger', position: { x: 0, y: 0 }, label: 'Trigger', data: { trigger: { type: 'input' } } },
      {
        id: 'llm-1',
        type: 'llm',
        position: { x: 0, y: 0 },
        label: 'agent',
        data: { name: 'agent', prompt: 'hi', provider: { type: 'mock', model: 'mock-1' } },
      },
      { id: 'tool-1', type: 'tool', position: { x: 0, y: 0 }, label: 'http', data: { toolName: 'http' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger-1', target: 'llm-1' },
      { id: 'e2', source: 'llm-1', target: 'tool-1' },
    ],
  };
}

describe('autoLayout', () => {
  it('spreads nodes out left-to-right in pipeline order', () => {
    const laidOut = autoLayout(graph());
    const byId = Object.fromEntries(laidOut.nodes.map((n) => [n.id, n.position]));
    expect(byId['trigger-1'].x).toBeLessThan(byId['llm-1'].x);
    expect(byId['llm-1'].x).toBeLessThan(byId['tool-1'].x);
  });

  it('preserves node identity, type and data - only position changes', () => {
    const original = graph();
    const laidOut = autoLayout(original);
    expect(laidOut.nodes.map((n) => n.id)).toEqual(original.nodes.map((n) => n.id));
    expect(laidOut.nodes.map((n) => n.data)).toEqual(original.nodes.map((n) => n.data));
    expect(laidOut.edges).toEqual(original.edges);
  });

  it('is a no-op on an empty graph', () => {
    const empty: AgentGraphSpec = { version: 1, nodes: [], edges: [] };
    expect(autoLayout(empty)).toEqual(empty);
  });
});
