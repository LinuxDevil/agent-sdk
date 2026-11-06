import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { toRfNodes } from '../CanvasArea';
import { setCollapsed } from '../../graph/v2/mutations';
import { specToGraph } from '../../graph/v2/specToGraph';
import type { AgentSpecV2 } from '../../graph/v2/specTypes';

/** The ticket's worked example: two leaf subagents and one inline group with a tool inside. */
const WORKED = `version: 2
name: support-triage
model: anthropic/claude-sonnet-5-5
instructions: Triage tickets.
subagents:
  billing: { ref: agents/billing.yaml }
  search:
    remote: { url: https://search.example.com, auth: { secret: search-token }, description: Web search agent }
  research:
    inline: { name: research, description: Looks things up, model: openai/gpt-5, instructions: Research., tools: [ { builtin: web-fetch } ] }
`;

const DECOR = {
  selectedNodeId: undefined,
  highlightedNodeId: undefined,
  breakpoints: [],
  statuses: {},
};

function workedGraph() {
  return specToGraph(parse(WORKED) as AgentSpecV2);
}

describe('toRfNodes: subagent groups', () => {
  it('types the inline subagent agent-group and parents its children', () => {
    const nodes = toRfNodes(workedGraph(), DECOR);
    const group = nodes.find((n) => n.id === 'sub:research')!;
    const tool = nodes.find((n) => n.id === 'sub:research/tool:web-fetch')!;
    expect(group.type).toBe('agent-group');
    expect(tool.parentId).toBe('sub:research');
    // Leaf subagent nodes stay ordinary cards.
    expect(nodes.find((n) => n.id === 'sub:billing')!.type).toBe('agent-subagent');
    expect(nodes.find((n) => n.id === 'sub:search')!.type).toBe('agent-subagent');
  });

  it('lists the group before its children (React Flow requires it)', () => {
    const ids = toRfNodes(workedGraph(), DECOR).map((n) => n.id);
    expect(ids.indexOf('sub:research')).toBeLessThan(ids.indexOf('sub:research/tool:web-fetch'));
  });

  it('hides the group\'s children when it is collapsed and keeps their parentId', () => {
    const graph = setCollapsed(workedGraph(), 'sub:research', true);
    const nodes = toRfNodes(graph, DECOR);
    const tool = nodes.find((n) => n.id === 'sub:research/tool:web-fetch')!;
    const group = nodes.find((n) => n.id === 'sub:research')!;
    expect(group.hidden).toBeFalsy();
    expect(tool.hidden).toBe(true);
    expect(tool.parentId).toBe('sub:research');
  });

  it('shows the children again when expanded', () => {
    const graph = workedGraph();
    const nodes = toRfNodes(graph, DECOR);
    expect(nodes.find((n) => n.id === 'sub:research/tool:web-fetch')!.hidden).toBeFalsy();
  });

  it('sizes an expanded group at its children bounds plus padding, at least 280x160', () => {
    const nodes = toRfNodes(workedGraph(), DECOR);
    const group = nodes.find((n) => n.id === 'sub:research')!;
    const style = group.style as { width: number; height: number };
    expect(style.width).toBeGreaterThanOrEqual(280);
    expect(style.height).toBeGreaterThanOrEqual(160);
  });

  it('grows the group to enclose a measured child', () => {
    const measured = { 'sub:research/tool:web-fetch': { width: 400, height: 200 } };
    const nodes = toRfNodes(workedGraph(), DECOR, measured);
    const group = nodes.find((n) => n.id === 'sub:research')!;
    const child = nodes.find((n) => n.id === 'sub:research/tool:web-fetch')!;
    const style = group.style as { width: number; height: number };
    expect(style.width).toBeGreaterThanOrEqual(child.position.x + 400 + 24);
    expect(style.height).toBeGreaterThanOrEqual(child.position.y + 200 + 24);
  });
});
