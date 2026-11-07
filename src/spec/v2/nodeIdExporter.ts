/**
 * The `lousho.node.id` exporter (S20a): wraps the host's TraceExporter so
 * every span of a spec-built agent carries the PLAN §3.3 node id of the
 * thing that produced it — `agent`, `tool:<…>`, `mcp:<…>`, `memory:<…>`,
 * `handoff:<…>`, `sub:<name>` (with `sub:<name>/…` children) and
 * `flow:<step id>` — and Studio can light up the canvas node without
 * guessing from names. The compiler (./specToAgent.ts) wraps
 * `host.exporter` with it and fills the shared {@link NodeIdIndex} before
 * `createAgent()` returns, so the map is complete before any span starts.
 * Only node ids ever land on spans — never spec values or secrets.
 * Node-side by use (the compiler is the only caller); no `node:*` imports.
 */
import { APPROVAL_WAIT_SPAN_NAME, FlowAttr, FLOW_NODE_SPAN_NAME, GUARDRAIL_SPAN_NAME, GenAiAttr, GenAiOperation, HANDOFF_SPAN_NAME, SdkAttr } from '../../execution/semconv';
import type { Span, TraceExporter } from '../../execution/tracing';
import type { HandoffSpec } from './handoffs';
import { specNodeIds } from './nodeIds';
import type { AgentSpecV2 } from './types';

/** What the exporter needs to map a span to a node id. Recursive for inline subagents. */
export interface NodeIdIndex {
  /** model-facing tool name → node id (from toolNamesByRef + SpecNodeIds.tools). */
  toolNodeByName: Record<string, string>;
  /** server key → 'mcp:<key>' (tool names are '<server>__<tool>'). */
  mcpServers: Record<string, string>;
  /** 'transfer_to_<x>' (or the handoff's toolName) → 'handoff:<agent>'. */
  handoffByToolName: Record<string, string>;
  /** slot name → 'memory:<name>'. */
  memorySlots: Record<string, string>;
  /** spec.guardrails entry id → 'guard:<id>' (S11 names each compiled guardrail by its entry id, so the trip name is the id). */
  guardrailByName: Record<string, string>;
  /** inline subagent name → its own index. */
  subagents: Record<string, NodeIdIndex>;
}

/**
 * The index of a spec's compiled form: `toolNamesByRef[i]` holds the
 * model-facing names `spec.tools[i]` produced (all mapped to that ref's
 * `tool:<…>` id), `subIndexes` the sub-agents' own indexes (name →
 * `nodeIdIndexOf(sub.spec, sub.toolNamesByRef)`; sub-agents without one —
 * remote, or compiled another way — simply resolve no tool ids).
 */
export function nodeIdIndexOf(
  spec: AgentSpecV2,
  toolNamesByRef: readonly (readonly string[])[],
  subIndexes: Record<string, NodeIdIndex> = {}
): NodeIdIndex {
  const nodes = specNodeIds(spec);
  const index: NodeIdIndex = {
    toolNodeByName: {},
    mcpServers: nodes.mcp,
    handoffByToolName: {},
    memorySlots: {},
    guardrailByName: {},
    subagents: subIndexes,
  };
  (spec.tools ?? []).forEach((_ref, i) => {
    for (const name of toolNamesByRef[i] ?? []) index.toolNodeByName[name] = nodes.tools[i];
  });
  (spec.memory ?? []).forEach((entry, i) => {
    index.memorySlots[entry.name] = nodes.memory[i];
  });
  for (const entry of spec.handoffs ?? []) {
    for (const name of handoffToolNames(spec, entry)) index.handoffByToolName[name] = `handoff:${entry.agent}`;
  }
  for (const entry of spec.guardrails ?? []) index.guardrailByName[entry.id] = `guard:${entry.id}`;
  return index;
}

/** `transfer_to_<name>` exactly as handoffAgents.ts builds it (illegal tool-name characters → '_', ≤64). */
function defaultHandoffToolName(name: string): string {
  return `transfer_to_${name.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64);
}

/**
 * The model-facing name(s) of one handoff's transfer tool: its explicit
 * `toolName`, else `transfer_to_<target agent name>`. The target's
 * createAgent name is the inline spec's `name` for a `{ inline }` sub-agent
 * target, which may differ from its key (and is unknowable here for `{ ref }`
 * and host-resolved targets) — so the entry's `agent` name is always mapped
 * too, covering both spellings.
 */
function handoffToolNames(spec: AgentSpecV2, entry: HandoffSpec): string[] {
  if (entry.toolName !== undefined) return [entry.toolName];
  const sub = spec.subagents?.[entry.agent];
  const names = new Set([entry.agent, sub !== undefined && 'inline' in sub ? sub.inline.name : entry.agent]);
  return [...names].map(defaultHandoffToolName);
}

/** The context a span's children resolve against (the enclosing agent's). */
interface SpanScope {
  /** Node-id prefix of the enclosing agent: '' at the root, 'sub:<name>/' inside a sub-agent. */
  scope: string;
  /** The enclosing agent's own node id ('agent' at the root, '<scope>sub:<n>' inside a sub). */
  agentNode: string;
  /** The index this scope's spans resolve tool names against. */
  index: NodeIdIndex;
  /** The `handoff:<to>` node id a `handoff` marker switched this run to (S20c); its `chat` spans stamp it from then on. */
  activeNode?: string;
  /** Set on the entries `invoke_agent` spans open — the only entries a `handoff` marker may switch. */
  forRun?: boolean;
}

/** A rule's answer: the `lousho.node.id` value to stamp (none stamps nothing) and the scope the span's children get. */
interface RuleHit {
  nodeId?: string;
  entry?: SpanScope;
}

/** One row of the S20a mapping table: returns the span's stamp (and the scope its children see), or undefined. */
type NodeIdRule = (span: Span, parent: SpanScope) => RuleHit | undefined;

/** `invoke_agent`: the root or enclosing agent; a `lousho.subagent.name` span opens a `sub:<n>` scope. */
const invokeAgentRule: NodeIdRule = (span, parent) => {
  if (span.attributes[GenAiAttr.OPERATION_NAME] !== GenAiOperation.INVOKE_AGENT) return undefined;
  const sub = span.attributes[SdkAttr.SUBAGENT_NAME];
  if (typeof sub !== 'string') {
    // Every run gets its own scope entry, so a `handoff` marker switches this run's
    // later `chat` spans without touching another run resolving through the same parent.
    return { nodeId: parent.agentNode, entry: { scope: parent.scope, agentNode: parent.agentNode, index: parent.index, forRun: true } };
  }
  const agentNode = `${parent.scope}sub:${sub}`;
  // A sub-agent with no index of its own (remote, or not spec-compiled) still stamps `sub:<n>`; its tools resolve none.
  return { nodeId: agentNode, entry: { scope: `${agentNode}/`, agentNode, index: parent.index.subagents[sub] ?? EMPTY_INDEX, forRun: true } };
};

/** `chat`: the node the run is on — its agent's, or the handoff target's once a `handoff` marker switched it. */
const chatRule: NodeIdRule = (span, parent) =>
  span.attributes[GenAiAttr.OPERATION_NAME] === GenAiOperation.CHAT ? { nodeId: parent.activeNode ?? parent.agentNode } : undefined;

/** `remember_x`/`recall_x`/`forget_x` memory tools name their slot. */
const MEMORY_TOOL_NAME = /^(?:remember|recall|forget)_(.+)$/;

/** The unprefixed node id of an `execute_tool` span's tool, first match of the four lookups. */
function toolNodeId(name: string, index: NodeIdIndex): string | undefined {
  const own = index.toolNodeByName[name];
  if (own !== undefined) return own;
  const server = Object.keys(index.mcpServers).find((key) => name.startsWith(`${key}__`));
  if (server !== undefined) return index.mcpServers[server];
  const handoff = index.handoffByToolName[name];
  if (handoff !== undefined) return handoff;
  const memory = MEMORY_TOOL_NAME.exec(name);
  return memory === null ? undefined : index.memorySlots[memory[1]];
}

/** `execute_tool`: the tool's own name from `gen_ai.tool.name`, else the span name's tail. */
function toolNameOf(span: Span): string | undefined {
  const attr = span.attributes[GenAiAttr.TOOL_NAME];
  if (typeof attr === 'string') return attr;
  const prefix = `${GenAiOperation.EXECUTE_TOOL} `;
  return span.name.startsWith(prefix) ? span.name.slice(prefix.length) : undefined;
}

/** `execute_tool <name>`: tool/mcp/handoff/memory node id, prefixed with the enclosing agent's scope. */
const toolRule: NodeIdRule = (span, parent) => {
  if (span.attributes[GenAiAttr.OPERATION_NAME] !== GenAiOperation.EXECUTE_TOOL) return undefined;
  const name = toolNameOf(span);
  const nodeId = name === undefined ? undefined : toolNodeId(name, parent.index);
  return nodeId === undefined ? undefined : { nodeId: parent.scope + nodeId };
};

/** `handoff <to>` (S20c): `<scope>handoff:<to>` — and the run's active node from then on. */
const handoffRule: NodeIdRule = (span, parent) => {
  if (!span.name.startsWith(`${HANDOFF_SPAN_NAME} `)) return undefined;
  const to = span.attributes[SdkAttr.HANDOFF_TO];
  if (typeof to !== 'string') return undefined;
  const nodeId = `${parent.scope}handoff:${to}`;
  // Only a run's own entry may be switched (an unparented marker sees the shared root).
  if (parent.forRun) parent.activeNode = nodeId;
  return { nodeId };
};

/** `approval.wait <tool>` (S20c): the node id `execute_tool <tool>` would get under the same scope. */
const approvalWaitRule: NodeIdRule = (span, parent) => {
  if (!span.name.startsWith(`${APPROVAL_WAIT_SPAN_NAME} `)) return undefined;
  const name = toolNameOf(span);
  const nodeId = name === undefined ? undefined : toolNodeId(name, parent.index);
  return nodeId === undefined ? undefined : { nodeId: parent.scope + nodeId };
};

/** `guardrail <name>` (S20b): the spec guardrail the span is named after; an unknown name (code-built, inherited) stamps nothing. */
const guardrailRule: NodeIdRule = (span, parent) => {
  if (!span.name.startsWith(`${GUARDRAIL_SPAN_NAME} `)) return undefined;
  const name = span.attributes[SdkAttr.GUARDRAIL_NAME];
  const nodeId = typeof name === 'string' ? parent.index.guardrailByName[name] : undefined;
  return nodeId === undefined ? undefined : { nodeId: parent.scope + nodeId };
};

/** `flow.node <type>` with `lousho.flow.node.id`: the step's `flow:<id>`. */
const flowNodeRule: NodeIdRule = (span) => {
  if (span.name !== FLOW_NODE_SPAN_NAME && !span.name.startsWith(`${FLOW_NODE_SPAN_NAME} `)) return undefined;
  const step = span.attributes[FlowAttr.NODE_ID];
  return typeof step === 'string' ? { nodeId: `flow:${step}` } : undefined;
};

/** The S20a mapping table, first hit wins; anything else gets no `lousho.node.id` (S20b/S20c extend it). */
const RULES: readonly NodeIdRule[] = [invokeAgentRule, chatRule, toolRule, handoffRule, approvalWaitRule, guardrailRule, flowNodeRule];

/** The index of a sub-agent compiled outside the spec pipeline (its spans stamp but resolve no members). */
const EMPTY_INDEX: NodeIdIndex = { toolNodeByName: {}, mcpServers: {}, handoffByToolName: {}, memorySlots: {}, guardrailByName: {}, subagents: {} };

/** Every exporter nodeIdExporter() returned, so isNodeIdExporter() needs no marker property. */
const nodeIdExporters = new WeakSet<TraceExporter>();

/**
 * Wraps `inner`; sets {@link SdkAttr}.NODE_ID on each span at start (a span
 * whose parent is unknown resolves at root scope), then forwards both hooks
 * unchanged — the same span object, in the same order. Scope entries are
 * deleted in `onSpanEnd`, so a long-lived agent does not leak.
 */
export function nodeIdExporter(inner: TraceExporter, index: NodeIdIndex): TraceExporter {
  const root: SpanScope = { scope: '', agentNode: 'agent', index };
  const scopes = new Map<string, SpanScope>();
  const exporter: TraceExporter = {
    onSpanStart(span) {
      const parent = (span.parentId === undefined ? undefined : scopes.get(span.parentId)) ?? root;
      const hit = RULES.map((rule) => rule(span, parent)).find((result) => result !== undefined);
      scopes.set(span.id, hit?.entry ?? parent);
      if (hit?.nodeId !== undefined) span.attributes = { ...span.attributes, [SdkAttr.NODE_ID]: hit.nodeId };
      inner.onSpanStart(span);
    },
    onSpanEnd(span) {
      scopes.delete(span.id);
      inner.onSpanEnd(span);
    },
  };
  nodeIdExporters.add(exporter);
  return exporter;
}

/** True for an exporter {@link nodeIdExporter} returned (so nested compiles do not wrap twice). */
export function isNodeIdExporter(exporter: TraceExporter | undefined): boolean {
  return exporter !== undefined && nodeIdExporters.has(exporter);
}
