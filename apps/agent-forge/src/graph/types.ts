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

export type AgentGraphNodeType = 'trigger' | 'llm' | 'tool' | 'approval' | 'output' | 'router';

export interface GraphPosition {
  x: number;
  y: number;
}

/**
 * LOU-Q3: which execution point a hook attached to a node runs at.
 * `toolCall` maps to the SDK's `preToolCall`/`postToolCall`, `generate`
 * maps to `preGenerate`/`postGenerate` (see src/execution/hooks.ts in the
 * core SDK). `phase` picks pre vs. post within that point.
 */
export type AgentNodeHookPhase = 'pre' | 'post';
export type AgentNodeHookPoint = 'toolCall' | 'generate';

/**
 * One hook instance attached to a node (LOU-Q2/Q3) - either dragged onto
 * the node from the LeftRail's Pre-hook/Post-hook palette item, or added
 * from the Inspector's "+ Add hook" starter-template list. `code` is the
 * editable JS function body a user authors in the Inspector's CodeMirror
 * editor; it is never eval()'d in-process - the server sandboxes it via the
 * same `SandboxAdapter` seam tool `sandboxExecute()` uses (see
 * server/hookSandbox.ts).
 */
export interface AgentNodeHookInstance {
  /** Stable id for this hook instance, unique within the node. */
  id: string;
  /** Which starter template (see src/hooks/hookTemplates.ts) this was created from, or 'custom'. */
  templateId: string;
  name: string;
  phase: AgentNodeHookPhase;
  point: AgentNodeHookPoint;
  /** Whether this hook actually runs when the agent executes (Inspector's toggle chip). */
  enabled: boolean;
  /** Editable JS function body: `async function(ctx) { ...; return ctx; }`. */
  code: string;
}

interface AgentGraphNodeBase<TType extends AgentGraphNodeType, TData> {
  id: string;
  type: TType;
  position: GraphPosition;
  /** Display label shown on the node's canvas header. */
  label: string;
  data: TData;
  /**
   * Hooks attached to this node (LOU-Q3). Present on any node type in
   * principle, but only `llm` (generate hooks) and `tool` (tool-call hooks)
   * nodes are meaningful drop targets today - see dnd.ts/CanvasArea.tsx.
   */
  hooks?: AgentNodeHookInstance[];
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

/**
 * LOU-T3: a "router" node has no config of its own - all of its behavior
 * lives on its OUTGOING EDGES (see `AgentGraphEdge.condition` below), the
 * same way `AgentGraphEdge` already carries no data for every other node
 * type today. Kept as an empty data object (like `OutputNodeData`) rather
 * than folding branch conditions into node `data`, so `graphMutations.ts`'s
 * existing edge-centric add/remove-connection functions are also the branch
 * add/remove functions - no second mutation path.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- branch data lives on edges, not the node (see comment above)
export interface RouterNodeData {}

export type AgentGraphNode =
  | AgentGraphNodeBase<'trigger', TriggerNodeData>
  | AgentGraphNodeBase<'llm', LlmNodeData>
  | AgentGraphNodeBase<'tool', ToolNodeData>
  | AgentGraphNodeBase<'approval', ApprovalNodeData>
  | AgentGraphNodeBase<'output', OutputNodeData>
  | AgentGraphNodeBase<'router', RouterNodeData>;

export interface AgentGraphEdge {
  id: string;
  source: string;
  target: string;
  /**
   * LOU-T3: present only on an edge whose `source` is a `router` node - the
   * branch condition, evaluated by `FlowExecutor.evaluateCondition()` at
   * runtime (see `src/flows/FlowExecutor.ts`): a `{{variable}}`-interpolated
   * JS expression string, `eval()`'d after interpolation against the flow's
   * runtime `variables` (the running conversation's message/tool-result
   * state - see `graphToFlow.ts`'s doc comment for exactly what's bound).
   * `interpolate()` is a raw, unquoted text substitution - comparing a
   * string variable needs the placeholder itself quoted (e.g.
   * `'{{classify}}' === 'refund'`, NOT `{{classify}} === 'refund'`, which
   * interpolates to an invalid bare identifier and always evaluates false)
   * - see `graphToFlow.ts`'s doc comment for the full explanation.
   * An edge out of a router with `condition` left `undefined`/empty is that
   * router's DEFAULT branch: `graphToFlow()` always compiles it last in the
   * generated `oneOf` node's `options` list regardless of the edges' order
   * in this array, since `FlowExecutor.executeOneOf()` takes the first
   * option whose condition is true OR the first option with no condition at
   * all - so a default sorted earlier would short-circuit every later
   * branch. At most one outgoing edge per router may omit `condition` (see
   * `validateGraph.ts`).
   */
  condition?: string;
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
