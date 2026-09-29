import type { AgentGraphNodeType } from './types';

/**
 * Which node-kind pairs may be connected by an edge, i.e. the port
 * compatibility rules for the fixed pipeline shape described in
 * graph/types.ts (trigger(s) -> llm -> tool(s) -> [approval] -> output).
 *
 * Used two places so the same rule set backs both "reject inline while
 * dragging a connection" (CanvasArea, LOU-M) and "catch it in a full
 * validateGraph() pass" (e.g. a graph saved/imported from outside the
 * canvas): a connection ReactFlow lets through client-side but that
 * violates these rules would otherwise only be caught at
 * graphToSpec()/save time, which is a worse experience than an inline
 * rejection the moment the user drags between two incompatible ports.
 */
const ALLOWED_EDGE_TYPES: Record<AgentGraphNodeType, AgentGraphNodeType[]> = {
  trigger: ['llm'],
  llm: ['tool', 'approval', 'output'],
  tool: ['tool', 'approval', 'output'],
  approval: ['output'],
  output: [],
};

export function isEdgeTypeAllowed(sourceType: AgentGraphNodeType, targetType: AgentGraphNodeType): boolean {
  return ALLOWED_EDGE_TYPES[sourceType]?.includes(targetType) ?? false;
}

/** Human-readable reason a connection is rejected, for inline UI feedback. */
export function edgeRejectionReason(sourceType: AgentGraphNodeType, targetType: AgentGraphNodeType): string {
  return `Can't connect ${sourceType} → ${targetType}: not a valid pipeline connection`;
}
