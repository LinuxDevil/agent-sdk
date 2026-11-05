/**
 * The re-own ("attach") effect: moving a capability node to another agent.
 * It lives in a leaf module — not in `mutations.ts` — because
 * `kinds/<kind>.ts` files implement `connectFrom` effects that need it, and
 * importing `mutations.ts` from a kind file would close an import cycle
 * (`mutations → kindRules → kinds/* → mutations`).
 */
import type { Graph, GraphNode, GraphPosition } from './types';
import { ROOT_AGENT_ID } from './types';

/**
 * The node's absolute canvas position: `position` is relative to the owner
 * group when the owner is an inline agent, so the absolute position is the
 * owner chain's positions plus the node's own.
 */
function absolutePosition(graph: Graph, node: GraphNode): GraphPosition {
  if (node.owner === null || node.owner === ROOT_AGENT_ID) return node.position;
  const owner = graph.nodes.find((n) => n.id === node.owner);
  if (owner === undefined) return node.position;
  const base = absolutePosition(graph, owner);
  return { x: base.x + node.position.x, y: base.y + node.position.y };
}

/** Where a node lands when it is re-owned into a group (the in-group grid's first cell). */
const GROUP_ENTRY_POSITION: GraphPosition = { x: 24, y: 48 };

/**
 * Moves a capability node to another agent. The node keeps its id
 * (`nodeIdMap` rekeys it at save). Entering a group moves it to
 * `{x:24,y:48}` inside the group; leaving a group restores its absolute
 * position (the old group's absolute position plus the relative one).
 * Unknown ids and no-ops return the same `Graph` reference.
 */
export function reownNode(graph: Graph, nodeId: string, newOwner: string): Graph {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const owner = graph.nodes.find((n) => n.id === newOwner);
  if (node === undefined || owner === undefined || node.owner === newOwner) return graph;
  const position =
    newOwner === ROOT_AGENT_ID ? absolutePosition(graph, node) : GROUP_ENTRY_POSITION;
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === nodeId ? { ...n, owner: newOwner, position: { ...position } } : n
    ),
  };
}
