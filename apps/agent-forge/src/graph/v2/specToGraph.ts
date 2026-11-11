/**
 * `specToGraph(spec, layout?)` — turns an `AgentSpecV2` plus its
 * `layout.json` into the canvas `Graph`: one `agent` node for the root spec
 * (and one per inline subagent, recursively), one node per section item,
 * layout positions where they exist and deterministic fallback positions
 * otherwise (`unplaced` records which). Spec data is referenced, not cloned:
 * `node.data.item` is the spec's own object — nothing here mutates inputs.
 * The `flow` section becomes a tree of `flow` nodes via `addFlowNodes`
 * (C15); a flow without a runnable root step stays in the agent's `extra`.
 */
import type { CanvasLayout } from '../../../shared/wireTypes';
import { addFlowNodes } from './flow';
import { HANDLED_SECTIONS } from './order';
import { addSpecNode, createSpecBuilder, type SpecToGraphBuilder } from './specBuilder';
import type { AgentFlow, AgentSpecV2, McpServerSpec, SubagentSpec } from './specTypes';
import type {
  AgentFields,
  AgentNodeData,
  Graph,
  GraphNode,
  OutputNodeData,
  SectionKey,
} from './types';
import { AGENT_FIELD_KEYS, ROOT_ONLY_SECTIONS, SECTION_KIND, SECTION_ORDER } from './types';

/** Sections an inline subagent's `addSections` may consume — `HANDLED_SECTIONS` minus the root-only ones. */
const INLINE_SECTIONS: ReadonlySet<SectionKey> = new Set(
  [...HANDLED_SECTIONS].filter((key) => !ROOT_ONLY_SECTIONS.includes(key))
);

const FIELD_KEYS: ReadonlySet<string> = new Set(AGENT_FIELD_KEYS);

/** `[]` or `{}` — a section present but empty, recorded in `emptySections` so it round-trips. */
function isEmptySection(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object' && value !== null) return Object.keys(value).length === 0;
  return false;
}

/**
 * `AgentNodeData` for a spec object: `fields` = present `AGENT_FIELD_KEYS`,
 * `extra` = every other key except `version` and the sections this level
 * consumes (on an inline agent `triggers`/`abortListeners`/`flow` are
 * root-only and stay in `extra`).
 */
function agentData(source: Record<string, unknown>, isRoot: boolean, subagentKey?: string): AgentNodeData {
  const fields: Record<string, unknown> = {};
  for (const key of AGENT_FIELD_KEYS) {
    if (source[key] !== undefined) fields[key] = source[key];
  }
  const sections = isRoot ? HANDLED_SECTIONS : INLINE_SECTIONS;
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (key === 'version' || FIELD_KEYS.has(key) || sections.has(key as SectionKey)) continue;
    extra[key] = source[key];
  }
  const data: AgentNodeData = { fields: fields as AgentFields, extra };
  if (subagentKey !== undefined) data.subagentKey = subagentKey;
  return data;
}

/** One node per item of an array section (`tools`, `skills`, …), `data: { item }`. */
function addArraySection(builder: SpecToGraphBuilder, ownerId: string, key: SectionKey, items: unknown[], inGroup: boolean): void {
  for (const item of items) {
    addSpecNode(builder, ownerId, SECTION_KIND[key], { item } as GraphNode['data'], inGroup);
  }
}

/** One `mcp` node per `mcpServers` entry, `data: { key, item }`. */
function addRecordSection(builder: SpecToGraphBuilder, ownerId: string, value: Record<string, unknown>, inGroup: boolean): void {
  for (const [key, item] of Object.entries(value)) {
    addSpecNode(builder, ownerId, 'mcp', { key, item: item as McpServerSpec }, inGroup);
  }
}

/**
 * One node per `subagents` entry: an `agent` node for `{ inline }` (whose
 * own sections follow immediately, depth-first), a `subagent` node for
 * `{ ref }` / `{ remote }`.
 */
function addSubagents(builder: SpecToGraphBuilder, ownerId: string, value: Record<string, SubagentSpec>, inGroup: boolean): void {
  for (const [key, item] of Object.entries(value)) {
    if ('inline' in item) {
      const inline = item.inline as unknown as Record<string, unknown>;
      const agent = addSpecNode(builder, ownerId, 'agent', agentData(inline, false, key), inGroup);
      addSections(builder, agent.id, inline, false);
    } else {
      addSpecNode(builder, ownerId, 'subagent', { key, item }, inGroup);
    }
  }
}

/**
 * The `flow` section: a tree of `flow` nodes under the root agent. When the
 * spec's `flow.flow` is missing or not a step object, `addFlowNodes` returns
 * false and the whole `flow` value lands back in the root agent's `extra`,
 * re-emitted verbatim exactly as before C15.
 */
function addFlowSection(builder: SpecToGraphBuilder, ownerId: string, value: unknown): void {
  if (addFlowNodes(builder, value as AgentFlow)) return;
  const owner = builder.nodes.find((n) => n.id === ownerId);
  if (owner !== undefined && owner.kind === 'agent') {
    (owner.data as AgentNodeData).extra['flow'] = value;
  }
}

/** `addSections` walks `SECTION_ORDER` ∩ the sections this owner level handles, recursing through inline subagents. */
function addSections(builder: SpecToGraphBuilder, ownerId: string, source: Record<string, unknown>, isRoot: boolean): void {
  const allowed = isRoot ? HANDLED_SECTIONS : INLINE_SECTIONS;
  const inGroup = !isRoot;
  for (const key of SECTION_ORDER) {
    if (!allowed.has(key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    // `flow` is an object, not an array/record section — and `flow: {}` must
    // stay in `extra` rather than become an `emptySections` entry.
    if (key === 'flow') {
      addFlowSection(builder, ownerId, value);
      continue;
    }
    if (isEmptySection(value)) {
      builder.emptySections.push({ owner: ownerId, key });
    } else if (Array.isArray(value)) {
      addArraySection(builder, ownerId, key, value, inGroup);
    } else if (key === 'mcpServers') {
      addRecordSection(builder, ownerId, value as Record<string, unknown>, inGroup);
    } else if (key === 'subagents') {
      addSubagents(builder, ownerId, value as Record<string, SubagentSpec>, inGroup);
    } else if (key === 'output') {
      addSpecNode(builder, ownerId, 'output', { item: value } as OutputNodeData, inGroup);
    }
  }
}

/** Converts an `AgentSpecV2` plus its `layout.json` into the canvas `Graph`. */
export function specToGraph(spec: AgentSpecV2, layout?: CanvasLayout): Graph {
  const source = spec as unknown as Record<string, unknown>;
  const builder = createSpecBuilder(layout);
  const root = addSpecNode(builder, null, 'agent', agentData(source, true), false);
  addSections(builder, root.id, source, true);
  for (const note of layout?.notes ?? []) {
    const id = `note:${note.id}`;
    builder.nodes.push({ id, kind: 'note', owner: null, position: { x: note.x, y: note.y }, data: { text: note.text } });
    builder.taken.add(id);
  }
  const graph: Graph = {
    version: 2,
    nodes: builder.nodes,
    emptySections: builder.emptySections,
    unplaced: builder.unplaced,
  };
  if (layout?.viewport !== undefined) graph.viewport = { ...layout.viewport };
  return graph;
}
