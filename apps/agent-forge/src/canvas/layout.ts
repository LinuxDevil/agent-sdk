import dagre from 'dagre';
import type { AgentGraphSpec } from '../graph/types';

const NODE_WIDTH = 190;
const NODE_HEIGHT = 96;

/**
 * Re-lays-out the current graph left-to-right with `dagre` (rank
 * direction LR matches the pipeline's natural
 * trigger -> llm -> tool -> approval -> output reading order). Only
 * touches node `position` - node/edge identity and data are untouched, so
 * this is safe to run on every "Auto layout" toolbar click without losing
 * anything but manual positioning.
 */
export function autoLayout(graph: AgentGraphSpec): AgentGraphSpec {
  if (graph.nodes.length === 0) return graph;

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 90 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of graph.nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of graph.edges) {
    if (graph.nodes.some((n) => n.id === edge.source) && graph.nodes.some((n) => n.id === edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(g);

  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const laidOut = g.node(node.id);
      if (!laidOut) return node;
      // dagre positions are node centers; AgentGraphNode.position is
      // top-left, matching how the canvas places nodes.
      return { ...node, position: { x: laidOut.x - NODE_WIDTH / 2, y: laidOut.y - NODE_HEIGHT / 2 } };
    }),
  };
}
