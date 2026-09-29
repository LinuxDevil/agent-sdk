import { isEdgeTypeAllowed } from './connectionRules';
import type { AgentGraphSpec, ValidationError, ValidationResult } from './types';

/**
 * Structural + per-node-type validation for `AgentGraphSpec`. Returns
 * structured errors (node/edge id + message) rather than throwing, so the
 * canvas UI (LOU-M) can surface them inline per-node instead of a single
 * crash.
 */
export function validateGraph(graph: AgentGraphSpec): ValidationResult {
  const errors: ValidationError[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  // Duplicate node ids.
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    if (seen.has(node.id)) {
      errors.push({ nodeId: node.id, message: `Duplicate node id '${node.id}'` });
    }
    seen.add(node.id);
  }

  // Dangling edges: source/target referencing a node id that doesn't exist.
  for (const edge of graph.edges) {
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

  // Edge type compatibility (only over edges whose endpoints both exist -
  // dangling edges are already reported above). See connectionRules.ts for
  // the allowed-pairs table (e.g. trigger -> trigger, or anything -> trigger,
  // is rejected).
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

  // Cycle detection (only over edges whose endpoints both exist).
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const list = adjacency.get(edge.source) ?? [];
    list.push(edge.target);
    adjacency.set(edge.source, list);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
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
  for (const id of cycleNodeIds) {
    errors.push({ nodeId: id, message: `Node '${id}' is part of a cycle` });
  }

  // Required-field checks per node type.
  for (const node of graph.nodes) {
    switch (node.type) {
      case 'llm': {
        if (!node.data.name?.trim()) {
          errors.push({ nodeId: node.id, message: "LLM node is missing required field 'name'" });
        }
        if (!node.data.prompt?.trim()) {
          errors.push({ nodeId: node.id, message: "LLM node is missing required field 'prompt'" });
        }
        if (!node.data.provider?.type?.trim()) {
          errors.push({ nodeId: node.id, message: "LLM node is missing required field 'provider.type'" });
        }
        if (!node.data.provider?.model?.trim()) {
          errors.push({ nodeId: node.id, message: "LLM node is missing required field 'provider.model'" });
        }
        break;
      }
      case 'tool': {
        if (!node.data.toolName?.trim()) {
          errors.push({ nodeId: node.id, message: "Tool node is missing required field 'toolName'" });
        }
        break;
      }
      case 'trigger': {
        if (!node.data.trigger?.type?.trim()) {
          errors.push({ nodeId: node.id, message: "Trigger node is missing required field 'trigger.type'" });
        }
        break;
      }
      case 'approval':
      case 'output':
        // No required fields for these node types today.
        break;
    }
  }

  // Exactly one llm node is required for graphToSpec() to succeed.
  const llmNodes = graph.nodes.filter((n) => n.type === 'llm');
  if (llmNodes.length === 0) {
    errors.push({ message: 'Graph must contain exactly one llm node, found none' });
  } else if (llmNodes.length > 1) {
    for (const n of llmNodes) {
      errors.push({
        nodeId: n.id,
        message: `Graph must contain exactly one llm node, found ${llmNodes.length}`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}
