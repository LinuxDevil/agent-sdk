/**
 * Per-kind extension points for mutations and validation: each node-kind
 * ticket (C03+) contributes a `KindRules` in `graph/v2/kinds/<kind>.ts` and
 * registers it in `KIND_RULES`, so `mutations.ts` and `validateGraph.ts`
 * stay a single mutation path and a single validation entry point that
 * never grow per-kind branches.
 */
import { agentRules } from './kinds/agent';
import { handoffRules } from './kinds/handoff';
import { mcpRules } from './kinds/mcp';
import { memoryRules } from './kinds/memory';
import { permissionRules } from './kinds/permission';
import { skillRules } from './kinds/skill';
import { subagentRules } from './kinds/subagent';
import { toolRules } from './kinds/tool';
import { triggerRules } from './kinds/trigger';
import type { Graph, GraphNode, NodeKind, NodeOfKind, Problem } from './types';

/** The result of a user-drawn edge: a new graph, or a refusal with a user-facing reason. */
export type ConnectResult = { ok: true; graph: Graph } | { ok: false; reason: string };

/**
 * The pure hooks one node kind may provide. Every hook is optional; the
 * mutations and validator fall back to defaults when it is absent
 * (`structuredClone(data)` for `duplicateData`, the re-own attach for
 * `connectFrom`).
 */
export interface KindRules<K extends NodeKind> {
  /** Problems for one node of this kind (required fields, references). */
  validate?: (node: NodeOfKind<K>, graph: Graph) => Problem[];
  /** What a user-drawn edge from a node of this kind does. Called only after canConnect() said ok. */
  connectFrom?: (source: NodeOfKind<K>, target: GraphNode, graph: Graph) => ConnectResult;
  /** Data for a duplicate: fresh ids/names so the copy is valid. Default: structuredClone(data). */
  duplicateData?: (node: NodeOfKind<K>, graph: Graph) => NodeOfKind<K>['data'];
}

/**
 * The registry every node-kind ticket extends — one entry per kind. Starts
 * with only `agent` (the default re-own connect effect); C03/C04/… add one
 * line per kind. The `agent` entry is a lazy getter because `kinds/agent.ts`
 * imports `mutations.ts` (for `reownNode`) while `mutations.ts` imports this
 * table: evaluating `agentRules` here at module-init time would hit a TDZ
 * error whenever `kinds/agent.ts` is the first module loaded in the cycle.
 */
export const KIND_RULES: { [K in NodeKind]?: KindRules<K> } = {
  get agent() {
    return agentRules;
  },
  subagent: subagentRules,
  tool: toolRules,
  handoff: handoffRules,
  mcp: mcpRules,
  skill: skillRules,
  memory: memoryRules,
  trigger: triggerRules,
  permission: permissionRules,
};
