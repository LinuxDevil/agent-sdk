/**
 * `specToGraph(spec, layout?)` — turns an `AgentSpecV2` plus its
 * `layout.json` into the canvas `Graph`: one `agent` node for the root spec
 * (and one per inline subagent, recursively), one node per section item,
 * layout positions where they exist and deterministic fallback positions
 * otherwise (`unplaced` records which). Spec data is referenced, not cloned:
 * `node.data.item` is the spec's own object — nothing here mutates inputs.
 */
import type { CanvasLayout } from '../../../shared/wireTypes';
import { fallbackColumn, fallbackPosition } from './fallbackLayout';
import { baseNodeId, dedupeId } from './nodeIds';
import { HANDLED_SECTIONS } from './order';
import type { AgentSpecV2, McpServerSpec, SubagentSpec } from './specTypes';
import type {
  AgentFields,
  AgentNodeData,
  EmptySection,
  Graph,
  GraphNode,
  NodeKind,
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

/** Node ids issued so far — `dedupeId`'s taken set. */
interface Builder {
  nodes: GraphNode[];
  emptySections: EmptySection[];
  unplaced: string[];
  taken: Set<string>;
  /** `'owner/column'` → how many fallback positions that column already gave out. */
  columnCounts: Map<string, number>;
  layout?: CanvasLayout;
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

/** Position from `layout.nodes[id]`, else a fallback position plus an `unplaced` entry. */
function place(builder: Builder, node: GraphNode, inGroup: boolean): void {
  const entry = builder.layout?.nodes[node.id];
  if (entry !== undefined) {
    node.position = { x: entry.x, y: entry.y };
    if (entry.collapsed !== undefined) node.collapsed = entry.collapsed;
    return;
  }
  const columnKind = node.kind === 'agent' && node.owner !== null ? 'subagent' : node.kind;
  const countKey = `${node.owner ?? ''}/${fallbackColumn(columnKind)}`;
  const indexInColumn = builder.columnCounts.get(countKey) ?? 0;
  builder.columnCounts.set(countKey, indexInColumn + 1);
  node.position = fallbackPosition(columnKind, indexInColumn, inGroup);
  builder.unplaced.push(node.id);
}

/** Deduped id + placement, then push. Nodes are pushed in exactly `orderedNodes` order. */
function addNode(
  builder: Builder,
  owner: string | null,
  kind: NodeKind,
  data: GraphNode['data'],
  inGroup: boolean
): GraphNode {
  const id = dedupeId(baseNodeId(kind, data, owner), builder.taken);
  const node = { id, kind, owner, data, position: { x: 0, y: 0 } } as GraphNode;
  place(builder, node, inGroup);
  builder.nodes.push(node);
  builder.taken.add(id);
  return node;
}

/** One node per item of an array section (`tools`, `skills`, …), `data: { item }`. */
function addArraySection(builder: Builder, ownerId: string, key: SectionKey, items: unknown[], inGroup: boolean): void {
  for (const item of items) {
    addNode(builder, ownerId, SECTION_KIND[key], { item } as GraphNode['data'], inGroup);
  }
}

/** One `mcp` node per `mcpServers` entry, `data: { key, item }`. */
function addRecordSection(builder: Builder, ownerId: string, value: Record<string, unknown>, inGroup: boolean): void {
  for (const [key, item] of Object.entries(value)) {
    addNode(builder, ownerId, 'mcp', { key, item: item as McpServerSpec }, inGroup);
  }
}

/**
 * One node per `subagents` entry: an `agent` node for `{ inline }` (whose
 * own sections follow immediately, depth-first), a `subagent` node for
 * `{ ref }` / `{ remote }`.
 */
function addSubagents(builder: Builder, ownerId: string, value: Record<string, SubagentSpec>, inGroup: boolean): void {
  for (const [key, item] of Object.entries(value)) {
    if ('inline' in item) {
      const inline = item.inline as unknown as Record<string, unknown>;
      const agent = addNode(builder, ownerId, 'agent', agentData(inline, false, key), inGroup);
      addSections(builder, agent.id, inline, false);
    } else {
      addNode(builder, ownerId, 'subagent', { key, item }, inGroup);
    }
  }
}

/** `addSections` walks `SECTION_ORDER` ∩ the sections this owner level handles, recursing through inline subagents. */
function addSections(builder: Builder, ownerId: string, source: Record<string, unknown>, isRoot: boolean): void {
  const allowed = isRoot ? HANDLED_SECTIONS : INLINE_SECTIONS;
  const inGroup = !isRoot;
  for (const key of SECTION_ORDER) {
    if (!allowed.has(key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    if (isEmptySection(value)) {
      builder.emptySections.push({ owner: ownerId, key });
    } else if (Array.isArray(value)) {
      addArraySection(builder, ownerId, key, value, inGroup);
    } else if (key === 'mcpServers') {
      addRecordSection(builder, ownerId, value as Record<string, unknown>, inGroup);
    } else if (key === 'subagents') {
      addSubagents(builder, ownerId, value as Record<string, SubagentSpec>, inGroup);
    } else if (key === 'output') {
      addNode(builder, ownerId, 'output', { item: value } as OutputNodeData, inGroup);
    }
  }
}

/** Converts an `AgentSpecV2` plus its `layout.json` into the canvas `Graph`. */
export function specToGraph(spec: AgentSpecV2, layout?: CanvasLayout): Graph {
  const source = spec as unknown as Record<string, unknown>;
  const builder: Builder = {
    nodes: [],
    emptySections: [],
    unplaced: [],
    taken: new Set(),
    columnCounts: new Map(),
    layout,
  };
  const root = addNode(builder, null, 'agent', agentData(source, true), false);
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
