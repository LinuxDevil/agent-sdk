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
  // LOU-T3: an `llm`/`tool` step can now feed a `router` node instead of
  // going straight to a tool/approval/output, letting the pipeline branch
  // on the result of that step.
  llm: ['tool', 'approval', 'output', 'router'],
  tool: ['tool', 'approval', 'output', 'router'],
  // LOU-T3: a router's branches can each continue into another llm/tool
  // step or terminate at output. Deliberately NOT `approval`:
  // `FlowExecutor` (src/flows/FlowExecutor.ts) has no
  // approval/needsApproval node type or checkpoint/resume concept, so an
  // approval-gated branch has nothing to compile to - see graphToFlow.ts's
  // doc comment for this same limitation, enforced there as a hard error.
  router: ['llm', 'tool', 'output'],
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
