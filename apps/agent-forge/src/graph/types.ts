/**
 * Agent graph data model (LOU-L2).
 *
 * `AgentGraphSpec` is the visual/graph-editor representation of the SDK's
 * existing `AgentSpec` (src/spec/schema.ts) - it is NOT a competing agent
 * format. Today's `AgentSpec` is deliberately flat: one prompt, one
 * provider, a flat `tools` string list, an optional `policy` and an
 * optional `triggers` list - there is no field in `AgentSpec` for
 * branching/routing between multiple LLM steps. So the graph this epic
 * renders is a fixed-shape pipeline that visualizes that flat spec as
 * nodes:
 *
 *   trigger(s) -> llm -> tool(s) -> [approval] -> output
 *
 * rather than an arbitrary user-wireable DAG of multiple LLM/tool steps.
 * That's a deliberate LOU-L scope decision, not an oversight: extending
 * `AgentSpec` itself to support multi-step orchestration/branching is a
 * bigger, cross-cutting change that belongs to a later epic (the canvas
 * work in LOU-M and/or the runtime control server in LOU-N), once we know
 * what the executor actually needs to run such a graph. Kept app-local
 * (apps/agent-forge/src/graph) rather than in the core SDK for the same
 * reason: this shape may well change once LOU-M/N land, and it has no
 * meaning outside the visual editor today.
 *
 * Fields that do NOT round-trip:
 *  - Node `position` (x/y canvas coordinates) has no equivalent in
 *    `AgentSpec` at all. `graphToSpec()` naturally drops it;
 *    `specToGraph()` always computes a fresh auto-layout position.
 *  - `AgentGraphEdge`s are not read by `graphToSpec()` - `AgentSpec` has no
 *    wiring/ordering field beyond the fixed pipeline shape above, so edges
 *    exist only for the canvas UI and for structural validation (cycle /
 *    dangling-edge checks). `specToGraph()` always regenerates a canonical
 *    edge set for the fixed pipeline; a user's custom edge routing (e.g. an
 *    edge into a *different* tool node, once branching exists) is not
 *    preserved across a spec round-trip today.
 *  - The synthetic `output` node carries no `AgentSpec` data at all (there
 *    is no output field in `AgentSpec`); it's always re-synthesized as a
 *    single fixed anchor node by `specToGraph()`.
 */

export type AgentGraphNodeType = 'trigger' | 'llm' | 'tool' | 'approval' | 'output';

export interface GraphPosition {
  x: number;
  y: number;
}

interface AgentGraphNodeBase<TType extends AgentGraphNodeType, TData> {
  id: string;
  type: TType;
  position: GraphPosition;
  /** Display label shown on the node's canvas header. */
  label: string;
  data: TData;
}

/** A single raw trigger object, kept verbatim from `AgentSpecTrigger`. */
export interface TriggerNodeData {
  trigger: { type: string; [key: string]: unknown };
}

export interface LlmNodeData {
  name: string;
  prompt: string;
  provider: { type: string; model: string };
}

export interface ToolNodeData {
  toolName: string;
}

/** Kept verbatim from `AgentSpecPolicy` so unknown/passthrough fields round-trip. */
export interface ApprovalNodeData {
  policy: { requiresApproval?: boolean; guardrails?: string[]; [key: string]: unknown };
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- output node carries no AgentSpec data (see file header)
export interface OutputNodeData {}

export type AgentGraphNode =
  | AgentGraphNodeBase<'trigger', TriggerNodeData>
  | AgentGraphNodeBase<'llm', LlmNodeData>
  | AgentGraphNodeBase<'tool', ToolNodeData>
  | AgentGraphNodeBase<'approval', ApprovalNodeData>
  | AgentGraphNodeBase<'output', OutputNodeData>;

export interface AgentGraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface AgentGraphSpec {
  /** Schema version for this app-local format, bumped on breaking shape changes. */
  version: 1;
  nodes: AgentGraphNode[];
  edges: AgentGraphEdge[];
}

export interface ValidationError {
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}
