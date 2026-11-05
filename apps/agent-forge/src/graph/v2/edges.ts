/**
 * `deriveEdges(graph)` — computes every canvas edge from node data; edges
 * are never stored (PLAN §18: "Canvas edges are always derived from node
 * data"). A reload or a spec edit changes the nodes, and the edges follow
 * for free.
 */
import { toolNodeName } from './nodeIds';
import type {
  AbortNodeData,
  EdgeKind,
  Graph,
  GraphEdge,
  GraphNode,
  McpNodeData,
  NodeKind,
  PermissionNodeData,
  ToolNodeData,
} from './types';
import { ROOT_AGENT_ID } from './types';

/** Edge label text; `''` means the edge carries no `label` key. */
export const EDGE_LABELS: Record<EdgeKind, string> = {
  starts: 'starts',
  uses: '',
  delegates: 'delegates',
  handsOff: 'hands off',
  guards: 'guards',
  governs: 'governs',
  hooks: 'hooks',
  returns: 'returns',
  cancels: 'cancels',
  runs: 'runs',
  next: '',
};

/**
 * Permission-rule patterns: `*` = any run of characters, `?` = one
 * character, everything else literal (`github__*` matches `github__issue`).
 */
export function globMatch(pattern: string, name: string): boolean {
  let source = '^';
  for (const ch of pattern) {
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(source + '$').test(name);
}

/** One derived edge: id `${kind}:${source}->${target}`, label only when `EDGE_LABELS` names one. */
function edge(kind: EdgeKind, source: string, target: string): GraphEdge {
  const label = EDGE_LABELS[kind];
  const e: GraphEdge = { id: `${kind}:${source}->${target}`, kind, source, target };
  if (label !== '') e.label = label;
  return e;
}

/** Owner → node edge kinds for capability nodes. */
const OWNER_EDGE_KIND: Partial<Record<NodeKind, EdgeKind>> = {
  tool: 'uses',
  mcp: 'uses',
  skill: 'uses',
  memory: 'uses',
  subagent: 'delegates',
  handoff: 'handsOff',
  guardrail: 'guards',
  hook: 'hooks',
  output: 'returns',
};

/** `governs` sources for a permission node: the owner's matching tool and mcp nodes, else the owner itself. */
function permissionEdges(node: GraphNode, nodes: GraphNode[]): GraphEdge[] {
  const patterns = [(node.data as PermissionNodeData).item.tool].flat();
  const sources: string[] = [];
  for (const other of nodes) {
    if (other.owner !== node.owner) continue;
    if (other.kind === 'tool') {
      const name = toolNodeName((other.data as ToolNodeData).item);
      if (patterns.some((p) => globMatch(p, name))) sources.push(other.id);
    } else if (other.kind === 'mcp') {
      const key = (other.data as McpNodeData).key;
      if (patterns.some((p) => p === '*' || p.startsWith(`${key}__`))) sources.push(other.id);
    }
  }
  if (sources.length === 0) {
    return node.owner === null ? [] : [edge('governs', node.owner, node.id)];
  }
  return sources.map((source) => edge('governs', source, node.id));
}

/** The edges one node contributes — by the table in the conversion ticket. */
function edgesFor(node: GraphNode, nodes: GraphNode[], ids: ReadonlySet<string>): GraphEdge[] {
  const ownerKind = node.kind === 'agent' ? 'delegates' : OWNER_EDGE_KIND[node.kind];
  if (ownerKind !== undefined) {
    return node.owner === null ? [] : [edge(ownerKind, node.owner, node.id)];
  }
  switch (node.kind) {
    case 'trigger':
      return [edge('starts', node.id, ROOT_AGENT_ID)];
    case 'abort': {
      const triggerId = `trigger:${(node.data as AbortNodeData).item.triggerId}`;
      return ids.has(triggerId) ? [edge('cancels', triggerId, node.id)] : [];
    }
    case 'permission':
      return permissionEdges(node, nodes);
    default:
      return []; // flow (C15), note
  }
}

/** Every edge of the graph, derived from node data in node-array order. */
export function deriveEdges(graph: Graph): GraphEdge[] {
  const nodes = graph.nodes.filter((n) => n.proposed !== 'remove');
  const ids = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [];
  for (const node of nodes) {
    edges.push(...edgesFor(node, nodes, ids));
  }
  return edges;
}
