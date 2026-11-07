/**
 * Canvas graph v2: the typed, agent-centred graph model of an `AgentSpecV2`.
 * Capability nodes attach to an agent node; subagents render as collapsible
 * groups containing their own capability nodes; flow steps form a separate
 * chain. Edges are derived from node data, never stored.
 *
 * All spec types come through `./specTypes` — nothing else in `graph/v2`
 * imports the SDK spec modules.
 */
import type {
  AbortListenerSpec,
  AgentFlow,
  AgentSpecV2,
  GuardrailSpec,
  HandoffSpec,
  HookSpec,
  McpServerSpec,
  MemorySpec,
  PermissionRuleSpec,
  SkillRef,
  SubagentSpec,
  ToolRef,
  TriggerSpec,
} from './specTypes';

/** The node kinds the canvas can show: the agent, its capability sections, flow steps and free notes. */
export type NodeKind =
  | 'agent' | 'subagent' | 'handoff' | 'tool' | 'mcp' | 'skill' | 'memory' | 'guardrail'
  | 'permission' | 'hook' | 'output' | 'trigger' | 'abort' | 'flow' | 'note';

/** Spec keys that become capability nodes. Order = canonical walk order (specToGraph, graphToSpec, orderedNodes). */
export const SECTION_ORDER = [
  'triggers', 'tools', 'mcpServers', 'skills', 'memory', 'subagents', 'handoffs',
  'guardrails', 'permissions', 'hooks', 'output', 'abortListeners', 'flow',
] as const;
/** A spec key that becomes capability nodes. */
export type SectionKey = (typeof SECTION_ORDER)[number];

/** Which node kind each section produces (subagents produce 'subagent' or, for inline, 'agent'). */
export const SECTION_KIND: Record<SectionKey, NodeKind> = {
  triggers: 'trigger', tools: 'tool', mcpServers: 'mcp', skills: 'skill', memory: 'memory',
  subagents: 'subagent', handoffs: 'handoff', guardrails: 'guardrail', permissions: 'permission',
  hooks: 'hook', output: 'output', abortListeners: 'abort', flow: 'flow',
};

/** Sections that only exist on the root agent (an inline subagent cannot have them). */
export const ROOT_ONLY_SECTIONS: readonly SectionKey[] = ['triggers', 'abortListeners', 'flow'];

/** Agent-level scalar/object fields edited on the agent node (everything that is not a section, `version` or `evals`). */
export const AGENT_FIELD_KEYS = [
  'name', 'description', 'model', 'fallbackModels', 'instructions', 'instructionsByFamily', 'promptRef',
  'modelSettings', 'reasoning', 'subagentOptions', 'maxSubagentDepth', 'maxHandoffs', 'permissionMode',
  'approvalTtlMs', 'askQuestion', 'limits', 'maxSteps', 'compaction', 'retry', 'rateLimit', 'promptCaching',
  'toolSearch', 'codeMode',
] as const;
/** One key of `AGENT_FIELD_KEYS`. */
export type AgentFieldKey = (typeof AGENT_FIELD_KEYS)[number];
/** The agent-level fields an agent node's inspector edits. */
export type AgentFields = Pick<AgentSpecV2, AgentFieldKey>;

/** Node id of the root agent (stable id rules: the root agent is always `agent`). */
export const ROOT_AGENT_ID = 'agent';

/** A node position on the canvas. */
export interface GraphPosition { x: number; y: number }

/** Data of an `agent` node: the root agent or an inline subagent. */
export interface AgentNodeData {
  /** The agent-level fields, edited on the agent node. */
  fields: AgentFields;
  /** Keys of this agent's spec object that no section or field handles (root: `evals`, `flow` before C15, unknown keys). Re-emitted verbatim. */
  extra: Record<string, unknown>;
  /** Set only on an inline subagent: its key in the parent's `subagents` record. */
  subagentKey?: string;
}
/** Data of a `subagent` node: a `spec.subagents` entry that is a ref or remote agent (inline entries become `agent` nodes). */
export interface SubagentNodeData { key: string; item: Exclude<SubagentSpec, { inline: unknown }> }
/** Data of a `handoff` node: one `spec.handoffs` entry. */
export interface HandoffNodeData { item: HandoffSpec }
/** Data of a `tool` node: one `spec.tools` entry. */
export interface ToolNodeData { item: ToolRef }
/** Data of an `mcp` node: one `spec.mcpServers` entry plus its record key. */
export interface McpNodeData { key: string; item: McpServerSpec }
/** Data of a `skill` node: one `spec.skills` entry. */
export interface SkillNodeData { item: SkillRef }
/** Data of a `memory` node: one `spec.memory` entry. */
export interface MemoryNodeData { item: MemorySpec }
/** Data of a `guardrail` node: one `spec.guardrails` entry. */
export interface GuardrailNodeData { item: GuardrailSpec }
/** Data of a `permission` node: one `spec.permissions` entry. */
export interface PermissionNodeData { item: PermissionRuleSpec }
/** Data of a `hook` node: one `spec.hooks` entry. */
export interface HookNodeData { item: HookSpec }
/** Data of an `output` node: the agent's `spec.output`. */
export interface OutputNodeData { item: NonNullable<AgentSpecV2['output']> }
/** Data of a `trigger` node: one `spec.triggers` entry. */
export interface TriggerNodeData { item: TriggerSpec }
/** Data of an `abort` node: one `spec.abortListeners` entry. */
export interface AbortNodeData { item: AbortListenerSpec }
/** Data of a `note` node: a free text note from the layout file. */
export interface NoteNodeData { text: string }

/** Where a flow step's children are, by node id (`flow:<step id>`). Filled in by C15. */
export type FlowChildren =
  | { shape: 'none' }
  | { shape: 'steps'; ids: string[] }                                         // sequence, parallel
  | { shape: 'options'; options: Array<{ condition?: string; id: string }> }  // oneOf
  | { shape: 'step'; id: string | null };                                     // forEach
/** Data of a `flow` node: one flow step plus where its children live. */
export interface FlowNodeData {
  /** The step object without its child-holding field (`steps`, `options` or `step`). Always has `id`. */
  step: { type: string; id: string; [key: string]: unknown };
  /** Where the step's children are, by node id. */
  children: FlowChildren;
  /** Only on the root step: the AgentFlow wrapper fields (code, name, description, inputs, agents, id). */
  flowMeta?: Omit<AgentFlow, 'flow'>;
}

/** Fields every graph node shares; `K` is the node's kind, `D` its kind-specific data. */
export interface GraphNodeBase<K extends NodeKind, D> {
  /** Stable node id (PLAN §3.3 rules, e.g. `tool:http`, `sub:research/tool:http`). */
  id: string;
  /** The node's kind. */
  kind: K;
  /** Id of the agent node this belongs to. `null` for the root agent and for notes. */
  owner: string | null;
  /** Top-left. Relative to the owner group when `owner` is an inline subagent; absolute otherwise. */
  position: GraphPosition;
  /** Copied from CanvasLayout; only meaningful on agent nodes (group collapsed). */
  collapsed?: boolean;
  /** Set by the proposal overlay (C21) only; never persisted. */
  proposed?: 'add' | 'remove' | 'edit';
  /** Kind-specific data. */
  data: D;
}

/** One node of the canvas graph, discriminated by `kind`. */
export type GraphNode =
  | GraphNodeBase<'agent', AgentNodeData> | GraphNodeBase<'subagent', SubagentNodeData>
  | GraphNodeBase<'handoff', HandoffNodeData> | GraphNodeBase<'tool', ToolNodeData>
  | GraphNodeBase<'mcp', McpNodeData> | GraphNodeBase<'skill', SkillNodeData>
  | GraphNodeBase<'memory', MemoryNodeData> | GraphNodeBase<'guardrail', GuardrailNodeData>
  | GraphNodeBase<'permission', PermissionNodeData> | GraphNodeBase<'hook', HookNodeData>
  | GraphNodeBase<'output', OutputNodeData> | GraphNodeBase<'trigger', TriggerNodeData>
  | GraphNodeBase<'abort', AbortNodeData> | GraphNodeBase<'flow', FlowNodeData>
  | GraphNodeBase<'note', NoteNodeData>;
/** The `GraphNode` variant of one kind. */
export type NodeOfKind<K extends NodeKind> = Extract<GraphNode, { kind: K }>;

/** A section key that was present but empty (`tools: []`, `mcpServers: {}`), so it round-trips. */
export interface EmptySection { owner: string; key: SectionKey }

/** The canvas graph of an agent spec: typed nodes plus the layout facts that are not nodes. */
export interface Graph {
  /** Graph model version. */
  version: 2;
  /** Every node of the canvas. */
  nodes: GraphNode[];
  /** Sections present but empty in the spec, so `graphToSpec` can re-emit them. */
  emptySections: EmptySection[];
  /** Ids whose position came from the fallback layout (no layout.json entry). C17 lays these out. Not persisted. */
  unplaced: string[];
  /** Canvas viewport, persisted to layout.json. */
  viewport?: { x: number; y: number; zoom: number };
}

/** The meaning of an edge between two nodes. */
export type EdgeKind =
  | 'starts' | 'uses' | 'delegates' | 'handsOff' | 'guards' | 'governs' | 'hooks' | 'returns' | 'cancels' | 'runs' | 'next';
/** Edges are derived from node data (C02 `deriveEdges`), never stored. */
export interface GraphEdge { id: string; kind: EdgeKind; source: string; target: string; label?: string; condition?: string }

/** PLAN §7 Problem. Graph-level problems use nodeId ROOT_AGENT_ID. */
export interface Problem { nodeId: string; severity: 'error' | 'warning'; message: string; fieldPath?: string }
