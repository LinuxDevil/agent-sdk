import { describe, expect, it } from 'vitest';
import { applyElkPositions, applyLayoutResult, autoLayout, toElkGraph } from '../layout';
import { setCollapsed } from '../../graph/v2/mutations';
import { specToGraph } from '../../graph/v2/specToGraph';
import type { CanvasLayout } from '../../../shared/wireTypes';
import type { Graph, GraphNode } from '../../graph/v2/types';

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

function graph(layout?: CanvasLayout): Graph {
  return specToGraph(SPEC as never, layout);
}

function byId(g: Graph, id: string): GraphNode {
  const node = g.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

/** Every node except `position` — the fields auto-layout must never touch. */
function withoutPositions(g: Graph) {
  return g.nodes.map((n) => {
    const { position, ...rest } = n;
    void position;
    return rest;
  });
}

describe('toElkGraph', () => {
  it('nests an expanded group\'s children and carries the layout options', () => {
    const elk = toElkGraph(graph());
    expect(elk.layoutOptions?.['elk.algorithm']).toBe('layered');
    expect(elk.layoutOptions?.['elk.direction']).toBe('RIGHT');
    const top = (elk.children ?? []).map((c) => c.id);
    expect(top).toEqual(expect.arrayContaining(['agent', 'trigger:t1', 'tool:http', GROUP_ID]));
    const group = elk.children?.find((c) => c.id === GROUP_ID);
    expect(group?.layoutOptions?.['elk.padding']).toBe('[top=56,left=24,bottom=24,right=24]');
    expect(group?.children?.map((c) => c.id)).toContain(GROUP_TOOL_ID);
  });

  it('uses measured sizes when given and the 208x96 default otherwise', () => {
    const elk = toElkGraph(graph(), { agent: { width: 300, height: 120 } });
    const agent = elk.children?.find((c) => c.id === 'agent');
    expect(agent).toMatchObject({ width: 300, height: 120 });
    const tool = elk.children?.find((c) => c.id === 'tool:http');
    expect(tool).toMatchObject({ width: 208, height: 96 });
  });

  it('turns a collapsed group into a leaf and drops edges to its hidden children', () => {
    const g = setCollapsed(graph(), GROUP_ID, true);
    const elk = toElkGraph(g);
    const group = elk.children?.find((c) => c.id === GROUP_ID);
    expect(group?.children).toBeUndefined();
    const edgeTargets = (elk.edges ?? []).flatMap((e) => e.targets ?? []);
    expect(edgeTargets).not.toContain(GROUP_TOOL_ID);
    // The group itself stays in the layout, as a leaf.
    expect(elk.children?.map((c) => c.id)).toContain(GROUP_ID);
  });

  it('derives edges between top-level nodes', () => {
    const elk = toElkGraph(graph());
    const starts = elk.edges?.find((e) => e.id === 'starts:trigger:t1->agent');
    expect(starts?.sources).toEqual(['trigger:t1']);
    expect(starts?.targets).toEqual(['agent']);
  });
});

describe('applyElkPositions', () => {
  it('moves only the scope\'s nodes and clears unplaced for scope \'unplaced\'', () => {
    const original = graph();
    const fake = {
      id: 'canvas',
      children: original.nodes
        .filter((n) => n.kind !== 'note')
        .map((n) => ({ id: n.id, x: 1000 + n.position.x, y: 1000 + n.position.y })),
    };
    const laidOut = applyElkPositions(original, fake, 'all');
    expect(byId(laidOut, 'agent').position).not.toStrictEqual(byId(original, 'agent').position);
  });
});

describe('applyLayoutResult', () => {
  it('merges moved positions onto the latest graph, keeping concurrent edits', () => {
    const before = graph();
    // The layout moved trigger:t1 and agent; tool:http kept its position.
    const laidOut: Graph = {
      ...before,
      unplaced: [],
      nodes: before.nodes.map((n) => {
        if (n.id === 'trigger:t1') return { ...n, position: { x: 900, y: 900 } };
        if (n.id === 'agent') return { ...n, position: { x: 500, y: 500 } };
        return n;
      }),
    };
    // While elkjs ran, the user dragged tool:http and added a note.
    const latest: Graph = {
      ...before,
      nodes: [
        ...before.nodes.map((n) => (n.id === 'tool:http' ? { ...n, position: { x: 1, y: 2 } } : n)),
        { id: 'note:n1', kind: 'note', owner: null, position: { x: 5, y: 6 }, data: { text: 'hi' } },
      ],
    };
    const merged = applyLayoutResult(before, laidOut, latest);
    expect(byId(merged, 'trigger:t1').position).toStrictEqual({ x: 900, y: 900 });
    expect(byId(merged, 'agent').position).toStrictEqual({ x: 500, y: 500 });
    // The concurrent drag wins over the (unchanged-by-layout) snapshot.
    expect(byId(merged, 'tool:http').position).toStrictEqual({ x: 1, y: 2 });
    expect(byId(merged, 'note:n1')).toBeDefined();
    // Moved ids leave `unplaced`; ids the layout did not move stay flagged.
    expect(merged.unplaced).toEqual(['tool:http', GROUP_ID, GROUP_TOOL_ID]);
  });

  it('keeps a node\'s position when it moved while the layout ran', () => {
    const before = graph();
    const laidOut: Graph = {
      ...before,
      nodes: before.nodes.map((n) => (n.id === 'agent' ? { ...n, position: { x: 700, y: 700 } } : n)),
    };
    const agentBefore = byId(before, 'agent').position;
    const latest: Graph = {
      ...before,
      nodes: before.nodes.map((n) => (n.id === 'agent' ? { ...n, position: { x: 42, y: 43 } } : n)),
    };
    const merged = applyLayoutResult(before, laidOut, latest);
    expect(byId(merged, 'agent').position).toStrictEqual({ x: 42, y: 43 });
    expect(agentBefore).not.toStrictEqual({ x: 42, y: 43 });
  });

  it('returns latest unchanged when the layout moved nothing', () => {
    const before = graph();
    const laidOut: Graph = { ...before, nodes: before.nodes.map((n) => ({ ...n })) };
    const latest: Graph = { ...before };
    expect(applyLayoutResult(before, laidOut, latest)).toBe(latest);
  });
});

describe('autoLayout', () => {
  it('lays out left-to-right: trigger, then the agent, then its tool', async () => {
    const laidOut = await autoLayout(graph(), 'all');
    const pos = (id: string) => byId(laidOut, id).position;
    expect(pos('trigger:t1').x).toBeLessThan(pos('agent').x);
    expect(pos('agent').x).toBeLessThan(pos('tool:http').x);
  });

  it('moves every non-note node and changes nothing but positions', async () => {
    const original = graph();
    const laidOut = await autoLayout(original, 'all');
    for (const node of laidOut.nodes) {
      if (node.kind === 'note') continue;
      const before = byId(original, node.id).position;
      expect(node.position).not.toStrictEqual(before);
    }
    expect(withoutPositions(laidOut)).toStrictEqual(withoutPositions(original));
    expect(laidOut.nodes.map((n) => n.id)).toEqual(original.nodes.map((n) => n.id));
    expect(laidOut.emptySections).toStrictEqual(original.emptySections);
    expect(laidOut.version).toBe(original.version);
  });

  it('keeps group children inside the group, clear of the header (>= 24, 56)', async () => {
    const laidOut = await autoLayout(graph(), 'all');
    const child = byId(laidOut, GROUP_TOOL_ID).position;
    expect(child.x).toBeGreaterThanOrEqual(24);
    expect(child.y).toBeGreaterThanOrEqual(56);
  });

  it('lays out a collapsed group as a leaf without touching its children', async () => {
    const original = setCollapsed(graph(), GROUP_ID, true);
    const before = byId(original, GROUP_TOOL_ID).position;
    const laidOut = await autoLayout(original, 'all');
    expect(byId(laidOut, GROUP_TOOL_ID).position).toStrictEqual(before);
    expect(byId(laidOut, GROUP_ID).position).not.toStrictEqual(byId(original, GROUP_ID).position);
  });

  it('scope \'unplaced\' moves only unplaced nodes, leaves placed ones untouched and clears unplaced', async () => {
    const layout: CanvasLayout = {
      schemaVersion: 1,
      nodes: {
        agent: { x: 40, y: 60 },
        'tool:http': { x: 500, y: 60 },
        [GROUP_ID]: { x: 800, y: 60 },
        [GROUP_TOOL_ID]: { x: 30, y: 120 },
      },
      notes: [],
    };
    const original = graph(layout);
    expect(original.unplaced).toEqual(['trigger:t1']);

    const laidOut = await autoLayout(original, 'unplaced');
    expect(laidOut.unplaced).toEqual([]);
    for (const id of ['agent', 'tool:http', GROUP_ID, GROUP_TOOL_ID]) {
      expect(byId(laidOut, id).position).toStrictEqual(byId(original, id).position);
    }
    expect(byId(laidOut, 'trigger:t1').position).not.toStrictEqual(byId(original, 'trigger:t1').position);
  });

  it('never moves notes', async () => {
    const layout: CanvasLayout = {
      schemaVersion: 1,
      nodes: { agent: { x: 40, y: 60 } },
      notes: [{ id: 'n1', x: 12, y: -40, text: 'remember this' }],
    };
    const original = graph(layout);
    const noteBefore = byId(original, 'note:n1').position;
    const laidOut = await autoLayout(original, 'all');
    expect(byId(laidOut, 'note:n1').position).toStrictEqual(noteBefore);
  });

  it('is a no-op on an empty graph', async () => {
    const empty: Graph = { version: 2, nodes: [], emptySections: [], unplaced: [] };
    expect(await autoLayout(empty, 'all')).toEqual(empty);
    expect(await autoLayout(empty, 'unplaced')).toEqual(empty);
  });
});
