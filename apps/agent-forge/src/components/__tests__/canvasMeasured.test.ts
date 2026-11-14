import { describe, expect, it } from 'vitest';
import { allVisibleMeasured, collapsedHiddenIds } from '../CanvasArea';
import { setCollapsed } from '../../graph/v2/mutations';
import { specToGraph } from '../../graph/v2/specToGraph';
import type { Graph } from '../../graph/v2/types';

/** Root agent + trigger + tool + an inline subagent group with its own tool. */
const SPEC = {
  version: 2,
  name: 'bot',
  model: 'mock/mock-1',
  instructions: 'hi',
  tools: [{ builtin: 'http' }],
  triggers: [{ id: 't1', type: 'chat' }],
  subagents: {
    research: {
      inline: {
        name: 'research',
        description: 'd',
        model: 'mock/mock-1',
        instructions: 'x',
        tools: [{ builtin: 'web-fetch' }],
      },
    },
  },
} as const;

const GROUP_ID = 'sub:research';
const GROUP_TOOL_ID = 'sub:research/tool:web-fetch';

function graph(collapsed = false): Graph {
  const g = specToGraph(SPEC as never);
  return collapsed ? setCollapsed(g, GROUP_ID, true) : g;
}

function measuredAll(g: Graph, skip: string[] = []): Record<string, { width: number; height: number }> {
  return Object.fromEntries(g.nodes.filter((n) => !skip.includes(n.id)).map((n) => [n.id, { width: 208, height: 96 }]));
}

describe('collapsedHiddenIds / allVisibleMeasured', () => {
  it('hides the whole subtree of a collapsed group', () => {
    const g = graph(true);
    const hidden = collapsedHiddenIds(g);
    expect(hidden.has(GROUP_TOOL_ID)).toBe(true);
    expect(hidden.has(GROUP_ID)).toBe(false); // the group card itself still renders
    expect(hidden.has('agent')).toBe(false);
  });

  it('an unmeasured node inside a collapsed group does not block the gate', () => {
    const g = graph(true);
    // Everything measured except the hidden group child - still passes.
    expect(allVisibleMeasured(g, measuredAll(g, [GROUP_TOOL_ID]))).toBe(true);
  });

  it('the same unmeasured child blocks the gate while the group is expanded', () => {
    const g = graph(false);
    expect(collapsedHiddenIds(g).size).toBe(0);
    expect(allVisibleMeasured(g, measuredAll(g, [GROUP_TOOL_ID]))).toBe(false);
  });

  it('a visible node without a measured size still blocks the gate', () => {
    const g = graph(true);
    expect(allVisibleMeasured(g, measuredAll(g, ['tool:http']))).toBe(false);
    expect(allVisibleMeasured(g, measuredAll(g))).toBe(true);
  });
});
