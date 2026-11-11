/**
 * `deriveEdges(graph)` — computes every canvas edge from node data; edges
 * are never stored (PLAN §18: "Canvas edges are always derived from node
 * data"). A reload or a spec edit changes the nodes, and the edges follow
 * for free.
 */
import { flowRoot } from './flow';
import { toolNodeName } from './nodeIds';
import { subagentEntryKey } from './order';
import type {
  AbortNodeData,
  EdgeKind,
  FlowNodeData,
  Graph,
  GraphEdge,
  GraphNode,
  HandoffNodeData,
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

/**
 * Whether a permission rule's `tool` patterns cover a tool node named
 * `name` — a glob match (`github__*` covers `github__issue`). Shared by
 * the `governs` edge derivation, the connect refusal and the validator's
 * 'No tool on this agent matches this rule' warning.
 */
export function ruleCoversTool(patterns: readonly string[], name: string): boolean {
  return patterns.some((pattern) => globMatch(pattern, name));
}

/**
 * Whether a permission rule's `tool` patterns cover every tool of MCP
 * server `key`: `'*'`, or any pattern under the `<key>__` prefix — both
 * `key__*` and a single-tool `key__tool` rule count.
 */
export function ruleCoversServer(patterns: readonly string[], key: string): boolean {
  return patterns.some((pattern) => pattern === '*' || pattern.startsWith(`${key}__`));
}

/** One derived edge: id `${kind}:${source}->${target}`, label only when `EDGE_LABELS` names one. */
function edge(kind: EdgeKind, source: string, target: string, label?: string, condition?: string): GraphEdge {
  const e: GraphEdge = { id: `${kind}:${source}->${target}`, kind, source, target };
  const text = label ?? EDGE_LABELS[kind];
  if (text !== '') e.label = text;
  if (condition !== undefined) e.condition = condition;
  return e;
}

/** A router option's edge label: the condition (≤ 24 chars + `…`) or `default`. */
function optionLabel(condition: string | undefined): string {
  if (condition === undefined) return 'default';
  return condition.length > 24 ? `${condition.slice(0, 24)}…` : condition;
}

/**
 * The `next` edges of one flow node: sequence children labelled `1`, `2`, …;
 * parallel children `parallel`; a router's options by condition/`default`
 * (carrying the condition); a loop's body `each`.
 */
function flowEdges(node: GraphNode, ids: ReadonlySet<string>): GraphEdge[] {
  const { step, children } = node.data as FlowNodeData;
  const edges: GraphEdge[] = [];
  // A dangling child reference (invalid graph) draws no edge — validation reports it.
  const live = (id: string | null): id is string => id !== null && ids.has(id);
  if (children.shape === 'steps') {
    const parallel = step.type === 'parallel';
    children.ids.forEach((id, i) => {
      if (live(id)) edges.push(edge('next', node.id, id, parallel ? 'parallel' : String(i + 1)));
    });
  } else if (children.shape === 'options') {
    for (const option of children.options) {
      if (live(option.id)) {
        edges.push(edge('next', node.id, option.id, optionLabel(option.condition), option.condition));
      }
    }
  } else if (children.shape === 'step' && live(children.id)) {
    edges.push(edge('next', node.id, children.id, 'each'));
  }
  return edges;
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
      if (ruleCoversTool(patterns, name)) sources.push(other.id);
    } else if (other.kind === 'mcp') {
      const key = (other.data as McpNodeData).key;
      if (ruleCoversServer(patterns, key)) sources.push(other.id);
    }
  }
  if (sources.length === 0) {
    return node.owner === null ? [] : [edge('governs', node.owner, node.id)];
  }
  return sources.map((source) => edge('governs', source, node.id));
}

/**
 * The handoff's second edge: `item.agent` naming a sibling `subagents`
 * entry (a ref/remote `subagent` node or an inline `agent` node of the same
 * owner) draws `handsOff` from the handoff to that node. The edge is
 * derived from node data like every other — never stored.
 */
function handoffTargetEdges(node: GraphNode, nodes: GraphNode[]): GraphEdge[] {
  const agent = (node.data as HandoffNodeData).item.agent;
  if (agent === '') return [];
  const target = nodes.find(
    (other) => other.owner === node.owner && subagentEntryKey(other) === agent
  );
  return target === undefined ? [] : [edge('handsOff', node.id, target.id)];
}

/** The edges one node contributes — by the table in the conversion ticket. */
function edgesFor(node: GraphNode, nodes: GraphNode[], ids: ReadonlySet<string>): GraphEdge[] {
  const ownerKind = node.kind === 'agent' ? 'delegates' : OWNER_EDGE_KIND[node.kind];
  if (ownerKind !== undefined) {
    if (node.owner === null) return [];
    const edges = [edge(ownerKind, node.owner, node.id)];
    if (node.kind === 'handoff') edges.push(...handoffTargetEdges(node, nodes));
    return edges;
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
    case 'flow':
      return flowEdges(node, ids);
    default:
      return []; // note
  }
}

/**
 * Every edge of the graph, derived from node data in node-array order.
 * `proposed: 'remove'` nodes are skipped unless `includeRemoved` — the
 * proposal overlay (C21) passes it so a removed node's edges still draw,
 * faded, instead of vanishing with the node.
 */
export function deriveEdges(graph: Graph, options?: { includeRemoved?: boolean }): GraphEdge[] {
  const nodes = graph.nodes.filter((n) => options?.includeRemoved === true || n.proposed !== 'remove');
  const ids = new Set(nodes.map((n) => n.id));
  const flowRootId = flowRoot(graph)?.id;
  const edges: GraphEdge[] = [];
  for (const node of nodes) {
    edges.push(...edgesFor(node, nodes, ids));
    // The root agent's `runs` edge to the flow root is derived like every
    // other edge — emitted once, when the root agent node is visited.
    if (node.id === ROOT_AGENT_ID && node.kind === 'agent' && flowRootId !== undefined) {
      edges.push(edge('runs', ROOT_AGENT_ID, flowRootId));
    }
  }
  return edges;
}
