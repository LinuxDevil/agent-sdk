import { describe, expect, it } from 'vitest';
import { autoLayout } from '../layout';
import { specToGraph } from '../../graph/v2/specToGraph';
import type { Graph } from '../../graph/v2/types';

function graph(): Graph {
  return specToGraph({
    version: 2,
    name: 'bot',
    model: 'mock/mock-1',
    instructions: 'hi',
    tools: [{ builtin: 'http' }],
    triggers: [{ id: 't1', type: 'chat' }],
  });
}

describe('autoLayout', () => {
  it('spreads nodes out left-to-right: trigger, then the agent, then its tool', () => {
    const laidOut = autoLayout(graph());
    const byId = Object.fromEntries(laidOut.nodes.map((n) => [n.id, n.position]));
    expect(byId['trigger:t1'].x).toBeLessThan(byId['agent'].x);
    expect(byId['agent'].x).toBeLessThan(byId['tool:http'].x);
  });

  it('preserves node identity, kind and data - only position changes', () => {
    const original = graph();
    const laidOut = autoLayout(original);
    expect(laidOut.nodes.map((n) => n.id)).toEqual(original.nodes.map((n) => n.id));
    expect(laidOut.nodes.map((n) => n.data)).toEqual(original.nodes.map((n) => n.data));
    expect(laidOut.nodes.map((n) => n.owner)).toEqual(original.nodes.map((n) => n.owner));
  });

  it('is a no-op on a graph with no top-level nodes', () => {
    const empty: Graph = { version: 2, nodes: [], emptySections: [], unplaced: [] };
    expect(autoLayout(empty)).toEqual(empty);
  });
});
