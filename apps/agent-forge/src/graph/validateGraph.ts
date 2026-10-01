import { isEdgeTypeAllowed } from './connectionRules';
import type { AgentGraphEdge, AgentGraphNode, AgentGraphSpec, ValidationError, ValidationResult } from './types';

function duplicateNodeIdErrors(nodes: AgentGraphNode[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) {
      errors.push({ nodeId: node.id, message: `Duplicate node id '${node.id}'` });
    }
    seen.add(node.id);
  }
  return errors;
}

/** Dangling edges: source/target referencing a node id that doesn't exist. */
function danglingEdgeErrors(edges: AgentGraphEdge[], nodeIds: Set<string>): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      errors.push({
        edgeId: edge.id,
        message: `Edge '${edge.id}' references missing source node '${edge.source}'`,
      });
    }
    if (!nodeIds.has(edge.target)) {
      errors.push({
        edgeId: edge.id,
        message: `Edge '${edge.id}' references missing target node '${edge.target}'`,
      });
    }
  }
  return errors;
}

/**
 * Edge type compatibility (only over edges whose endpoints both exist -
 * dangling edges are already reported separately). See connectionRules.ts for
 * the allowed-pairs table (e.g. trigger -> trigger, or anything -> trigger,
 * is rejected).
 */
function incompatibleEdgeErrors(graph: AgentGraphSpec): ValidationError[] {
  const errors: ValidationError[] = [];
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const edge of graph.edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) continue;
    if (!isEdgeTypeAllowed(source.type, target.type)) {
      errors.push({
        edgeId: edge.id,
        message: `Edge '${edge.id}' connects incompatible node types '${source.type}' -> '${target.type}'`,
      });
    }
  }
  return errors;
}

/** Adjacency list over edges whose endpoints both exist. */
function buildAdjacency(edges: AgentGraphEdge[], nodeIds: Set<string>): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const list = adjacency.get(edge.source) ?? [];
    list.push(edge.target);
    adjacency.set(edge.source, list);
  }
  return adjacency;
}

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

/** Cycle detection (only over edges whose endpoints both exist). */
function cycleErrors(graph: AgentGraphSpec, nodeIds: Set<string>): ValidationError[] {
  const adjacency = buildAdjacency(graph.edges, nodeIds);
  const color = new Map<string, number>();
  for (const node of graph.nodes) color.set(node.id, WHITE);

  const cycleNodeIds = new Set<string>();
  function visit(nodeId: string, stack: string[]): boolean {
    color.set(nodeId, GRAY);
    stack.push(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      const state = color.get(next);
      if (state === GRAY) {
        // Found a cycle: mark every node on the stack from `next` onward.
        const cycleStart = stack.indexOf(next);
        for (const id of stack.slice(cycleStart)) cycleNodeIds.add(id);
        return true;
      }
      if (state === WHITE && visit(next, stack)) {
        return true;
      }
    }
    stack.pop();
    color.set(nodeId, BLACK);
    return false;
  }

  for (const node of graph.nodes) {
    if (color.get(node.id) === WHITE) {
      visit(node.id, []);
    }
  }
  return [...cycleNodeIds].map((id) => ({ nodeId: id, message: `Node '${id}' is part of a cycle` }));
}

/** One required string field on a node: reported as missing when blank. */
interface FieldCheck {
  label: string;
  field: string;
  value: string | undefined;
}

type RequiredChecks = {
  [T in AgentGraphNode['type']]?: (node: Extract<AgentGraphNode, { type: T }>) => FieldCheck[];
};

/**
 * Required-field checks per node type. `approval`/`output` have no required
 * fields today, and `router` has no node-level fields - see the router
 * branch-edge checks below.
 */
const REQUIRED_CHECKS: RequiredChecks = {
  llm: (node) => [
    { label: 'LLM', field: 'name', value: node.data.name },
    { label: 'LLM', field: 'prompt', value: node.data.prompt },
    { label: 'LLM', field: 'provider.type', value: node.data.provider?.type },
    { label: 'LLM', field: 'provider.model', value: node.data.provider?.model },
  ],
  tool: (node) => [{ label: 'Tool', field: 'toolName', value: node.data.toolName }],
  trigger: (node) => [{ label: 'Trigger', field: 'trigger.type', value: node.data.trigger?.type }],
};

function requiredFieldErrors(node: AgentGraphNode): ValidationError[] {
  const checksFor = REQUIRED_CHECKS[node.type] as ((node: AgentGraphNode) => FieldCheck[]) | undefined;
  return (checksFor?.(node) ?? [])
    .filter((check) => !check.value?.trim())
    .map((check) => ({
      nodeId: node.id,
      message: `${check.label} node is missing required field '${check.field}'`,
    }));
}

/**
 * LOU-T3: router branch checks - each router's OUTGOING edges are its
 * branches (see graph/types.ts's `AgentGraphEdge.condition`). A router
 * with fewer than two outgoing edges isn't actually branching (it's just
 * an expensive pass-through), and more than one edge with no condition
 * is ambiguous about which one is "the" default - graphToFlow() can only
 * honor the first it walks.
 */
function routerBranchErrors(node: AgentGraphNode, edges: AgentGraphEdge[]): ValidationError[] {
  if (node.type !== 'router') return [];
  const errors: ValidationError[] = [];
  const outgoing = edges.filter((e) => e.source === node.id);
  if (outgoing.length < 2) {
    errors.push({
      nodeId: node.id,
      message: `Router node '${node.id}' must have at least 2 outgoing branches, found ${outgoing.length}`,
    });
  }
  const defaults = outgoing.filter((e) => !e.condition?.trim());
  if (defaults.length > 1) {
    errors.push({
      nodeId: node.id,
      message: `Router node '${node.id}' has ${defaults.length} branches with no condition - at most one default branch is allowed`,
    });
  }
  return errors;
}

/**
 * LOU-Q3: an enabled hook with no code body would silently no-op at
 * runtime (sandboxRunHook() would just run an empty function) - flag it
 * here so the Inspector's hook-chip list can surface it inline, the same
 * way a required node field is surfaced above.
 */
function emptyHookErrors(node: AgentGraphNode): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const hook of node.hooks ?? []) {
    if (hook.enabled && !hook.code.trim()) {
      errors.push({ nodeId: node.id, message: `Hook '${hook.name}' on node '${node.id}' is enabled but has no code` });
    }
  }
  return errors;
}

/** Exactly one llm node is required for graphToSpec() to succeed. */
function llmCountErrors(nodes: AgentGraphNode[]): ValidationError[] {
  const llmNodes = nodes.filter((n) => n.type === 'llm');
  if (llmNodes.length === 0) {
    return [{ message: 'Graph must contain exactly one llm node, found none' }];
  }
  if (llmNodes.length === 1) return [];
  return llmNodes.map((n) => ({
    nodeId: n.id,
    message: `Graph must contain exactly one llm node, found ${llmNodes.length}`,
  }));
}

/**
 * Structural + per-node-type validation for `AgentGraphSpec`. Returns
 * structured errors (node/edge id + message) rather than throwing, so the
 * canvas UI (LOU-M) can surface them inline per-node instead of a single
 * crash.
 */
export function validateGraph(graph: AgentGraphSpec): ValidationResult {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const errors: ValidationError[] = [
    ...duplicateNodeIdErrors(graph.nodes),
    ...danglingEdgeErrors(graph.edges, nodeIds),
    ...incompatibleEdgeErrors(graph),
    ...cycleErrors(graph, nodeIds),
    ...graph.nodes.flatMap(requiredFieldErrors),
    ...graph.nodes.flatMap((node) => routerBranchErrors(node, graph.edges)),
    ...graph.nodes.flatMap(emptyHookErrors),
    ...llmCountErrors(graph.nodes),
  ];
  return { valid: errors.length === 0, errors };
}
