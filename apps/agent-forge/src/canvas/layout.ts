import dagre from 'dagre';
import { deriveEdges } from '../graph/v2/edges';
import type { Graph } from '../graph/v2/types';
import { ROOT_AGENT_ID } from '../graph/v2/types';

/** `.rf-node`'s width (agents.css). */
const NODE_WIDTH = 208;
const NODE_HEIGHT = 96;

/**
 * Re-lays-out the current graph left-to-right with `dagre`. Only nodes at
 * the top level take part - a node owned by an inline agent keeps its
 * relative position inside its group. Only touches `position`, so this is
 * safe to run on every "Auto layout" toolbar click without losing anything
 * but manual positioning. elkjs (C17) replaces this.
 */
export function autoLayout(graph: Graph): Graph {
  // Only top-level nodes participate: positions inside a subagent group
  // are relative to the group and stay as they are.
  const topLevel = graph.nodes.filter((n) => n.owner === null || n.owner === ROOT_AGENT_ID);
  if (topLevel.length === 0) return graph;

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 48 });
  g.setDefaultEdgeLabel(() => ({}));

  const ids = new Set(topLevel.map((n) => n.id));
  for (const node of topLevel) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of deriveEdges(graph)) {
    if (ids.has(edge.source) && ids.has(edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(g);

  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (!ids.has(node.id)) return node;
      const laidOut = g.node(node.id);
      if (!laidOut) return node;
      // dagre positions are node centers; GraphPosition is
      // top-left, matching how the canvas places nodes.
      return { ...node, position: { x: laidOut.x - NODE_WIDTH / 2, y: laidOut.y - NODE_HEIGHT / 2 } };
    }),
  };
}
