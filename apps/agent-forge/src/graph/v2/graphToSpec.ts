/**
 * `graphToSpec(graph, previousSpec?)` — the inverse of `specToSpec`: folds
 * the canvas `Graph` back into an `AgentSpecV2`, rebuilds `layout.json`
 * under the node ids `specToGraph` would give today (`nodeIdMap` says how
 * they changed), and reports each node's spec path (`specPaths`) so
 * validation can map zod issues back to nodes. Pure: the graph is never
 * mutated and `proposed: 'remove'` nodes are skipped as if absent.
 */
import type { CanvasLayout } from '../../../shared/wireTypes';
import { flowSpecPaths, graphToFlow } from './flow';
import { HANDLED_SECTIONS, orderedNodes, orderKeys, sectionChildren } from './order';
import type { AgentFlow, AgentSpecV2 } from './specTypes';
import { specToGraph } from './specToGraph';
import type {
  AgentNodeData,
  Graph,
  GraphNode,
  McpNodeData,
  NoteNodeData,
  OutputNodeData,
  SectionKey,
  SubagentNodeData,
} from './types';
import { ROOT_AGENT_ID, SECTION_ORDER } from './types';

/** The result of folding a `Graph` back into a spec plus its layout. */
export interface GraphToSpecResult {
  spec: AgentSpecV2;
  layout: CanvasLayout;
  /** current graph node id → the id specToGraph(spec) will give it (differs after edits that change a name). */
  nodeIdMap: Record<string, string>;
  /** current graph node id → spec path ('' root, 'tools[2]', 'mcpServers.github', 'subagents.r.inline.tools[0]', 'output'). */
  specPaths: Record<string, string>;
}

/** Shared emission state for one `graphToSpec` call. */
interface EmitContext {
  graph: Graph;
  specPaths: Record<string, string>;
  /** `'owner|key'` of each section that was present but empty (`tools: []`, `mcpServers: {}`). */
  emptySections: ReadonlySet<string>;
}

/** The empty value a section key re-emits when it was present but empty. */
function emptyValue(key: SectionKey): unknown {
  return key === 'mcpServers' || key === 'subagents' || key === 'output' || key === 'flow' ? {} : [];
}

/** `previous.subagents[key].inline` when it exists and is an object — the key-order hint for a rebuilt inline subagent. */
function previousInline(
  previous: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined {
  const subagents = previous?.['subagents'];
  if (subagents === null || typeof subagents !== 'object' || Array.isArray(subagents)) return undefined;
  const entry = (subagents as Record<string, unknown>)[key];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const inline = (entry as Record<string, unknown>)['inline'];
  return inline !== null && typeof inline === 'object' && !Array.isArray(inline)
    ? (inline as Record<string, unknown>)
    : undefined;
}

/** One `subagents` record entry: a ref/remote verbatim, or a recursively rebuilt `{ inline }`. */
function emitSubagentEntry(
  ctx: EmitContext,
  record: Record<string, unknown>,
  child: GraphNode,
  prefix: string,
  previous?: Record<string, unknown>
): void {
  if (child.kind !== 'agent') {
    const data = child.data as SubagentNodeData;
    record[data.key] = data.item;
    ctx.specPaths[child.id] = `${prefix}subagents.${data.key}`;
    return;
  }
  const key = (child.data as AgentNodeData).subagentKey ?? '';
  const prevInline = previousInline(previous, key);
  const path = `${prefix}subagents.${key}.inline`;
  ctx.specPaths[child.id] = path;
  record[key] = { inline: orderKeys(buildAgentObject(ctx, child, path, prevInline), prevInline) };
}

/** `mcpServers` → `{ key: item }`; `subagents` → `{ key: item | { inline } }`, children in node order. */
function emitRecordSection(
  ctx: EmitContext,
  key: 'mcpServers' | 'subagents',
  children: GraphNode[],
  prefix: string,
  previous?: Record<string, unknown>
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  if (key === 'mcpServers') {
    for (const child of children) {
      const data = child.data as McpNodeData;
      record[data.key] = data.item;
      ctx.specPaths[child.id] = `${prefix}mcpServers.${data.key}`;
    }
    return record;
  }
  for (const child of children) {
    emitSubagentEntry(ctx, record, child, prefix, previous);
  }
  return record;
}

/** Emit `obj[key]` from `ownerNode`'s children of section `key` — or the remembered empty value. */
function emitSection(
  ctx: EmitContext,
  ownerNode: GraphNode,
  key: SectionKey,
  parentPath: string,
  obj: Record<string, unknown>,
  previous?: Record<string, unknown>
): void {
  const prefix = parentPath === '' ? '' : parentPath + '.';
  const children = sectionChildren(ctx.graph, ownerNode.id, key);
  if (children.length === 0) {
    if (ctx.emptySections.has(`${ownerNode.id}|${key}`)) obj[key] = emptyValue(key);
    return;
  }
  if (key === 'output') {
    const first = children[0];
    obj[key] = (first.data as OutputNodeData).item;
    ctx.specPaths[first.id] = `${prefix}output`;
    return;
  }
  if (key === 'mcpServers' || key === 'subagents') {
    obj[key] = emitRecordSection(ctx, key, children, prefix, previous);
    return;
  }
  // `flow` is a step tree, not an item list: `graphToFlow` rebuilds the
  // AgentFlow and `flowSpecPaths` gives every flow node its spec path.
  if (key === 'flow') {
    const flow = graphToFlow(ctx.graph, previous?.['flow'] as AgentFlow | undefined);
    if (flow !== undefined) {
      obj[key] = flow;
      for (const [id, path] of Object.entries(flowSpecPaths(ctx.graph))) {
        ctx.specPaths[id] = path;
      }
    }
    return;
  }
  obj[key] = children.map((child, i) => {
    ctx.specPaths[child.id] = `${prefix}${key}[${i}]`;
    return (child.data as { item: unknown }).item;
  });
}

/** `{ ...fields, ...sections, ...extra }` for one agent node; `parentPath` is its spec path ('' for the root). */
function buildAgentObject(
  ctx: EmitContext,
  agentNode: GraphNode,
  parentPath: string,
  previous?: Record<string, unknown>
): Record<string, unknown> {
  const data = agentNode.data as AgentNodeData;
  const obj: Record<string, unknown> = { ...data.fields };
  for (const key of SECTION_ORDER) {
    if (HANDLED_SECTIONS.has(key)) emitSection(ctx, agentNode, key, parentPath, obj, previous);
  }
  Object.assign(obj, data.extra);
  return obj;
}

/** current graph node id → the id `specToGraph(spec)` gives it, by zipping the two canonical walks. */
function buildNodeIdMap(graph: Graph, spec: AgentSpecV2): Record<string, string> {
  const canonical = orderedNodes(specToGraph(spec));
  const actual = orderedNodes(graph);
  if (canonical.length !== actual.length) throw new Error('graphToSpec: node walk mismatch');
  const map: Record<string, string> = {};
  actual.forEach((node, i) => {
    map[node.id] = canonical[i].id;
  });
  return map;
}

/** The `layout.json` for the emitted spec: positions under today's ids, notes and the viewport. */
function buildLayout(graph: Graph, nodeIdMap: Record<string, string>): CanvasLayout {
  const nodes: CanvasLayout['nodes'] = {};
  for (const node of orderedNodes(graph)) {
    const entry: { x: number; y: number; collapsed?: boolean } = { x: node.position.x, y: node.position.y };
    if (node.collapsed !== undefined) entry.collapsed = node.collapsed;
    nodes[nodeIdMap[node.id]] = entry;
  }
  const layout: CanvasLayout = {
    schemaVersion: 1,
    nodes,
    notes: graph.nodes
      .filter((node) => node.kind === 'note' && node.proposed !== 'remove')
      .map((node) => ({
        id: node.id.slice('note:'.length),
        x: node.position.x,
        y: node.position.y,
        text: (node.data as NoteNodeData).text,
      })),
  };
  if (graph.viewport !== undefined) layout.viewport = { ...graph.viewport };
  return layout;
}

/** Folds a canvas `Graph` back into `{ spec, layout, nodeIdMap, specPaths }`. Throws when the graph has no root agent node. */
export function graphToSpec(graph: Graph, previousSpec?: AgentSpecV2): GraphToSpecResult {
  const root = graph.nodes.find(
    (n) => n.id === ROOT_AGENT_ID && n.kind === 'agent' && n.owner === null && n.proposed !== 'remove'
  );
  if (root === undefined) throw new Error('graphToSpec: graph has no root agent node');
  const ctx: EmitContext = {
    graph,
    specPaths: { [root.id]: '' },
    emptySections: new Set(graph.emptySections.map((e) => `${e.owner}|${e.key}`)),
  };
  const previous = previousSpec as unknown as Record<string, unknown> | undefined;
  const agentObject = buildAgentObject(ctx, root, '', previous);
  const spec = orderKeys({ version: 2, ...agentObject }, previous) as unknown as AgentSpecV2;
  const nodeIdMap = buildNodeIdMap(graph, spec);
  return { spec, layout: buildLayout(graph, nodeIdMap), nodeIdMap, specPaths: ctx.specPaths };
}
