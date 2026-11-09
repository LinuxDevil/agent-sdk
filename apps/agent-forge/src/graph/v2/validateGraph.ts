/**
 * `validateGraph(graph)` — the single validation entry point for the v2
 * canvas (C19 renders the result as badges and a Problems panel). A table
 * of core structural checks runs first; then each node may add problems via
 * `KIND_RULES[kind].validate` (the per-kind extension point — one line per
 * kind ticket). Spec paths for `fieldPath` come from one `graphToSpec`
 * call, never one per node.
 */
import { graphToSpec } from './graphToSpec';
import { KIND_RULES } from './kindRules';
import { schemaProblems } from './schemaIssues';
import { orderedNodes, sectionChildren, subagentEntryKey, HANDLED_SECTIONS } from './order';
import type { AgentSpecV2 } from './specTypes';
import type {
  AgentNodeData,
  Graph,
  GraphNode,
  McpNodeData,
  MemoryNodeData,
  NodeKind,
  Problem,
  SectionKey,
  SubagentNodeData,
} from './types';
import { ROOT_AGENT_ID, ROOT_ONLY_KINDS, SECTION_ORDER } from './types';

/** `graph.nodes` minus nodes marked `proposed: 'remove'` (a marked node is not part of the spec). */
function liveNodes(graph: Graph): GraphNode[] {
  return graph.nodes.filter((n) => n.proposed !== 'remove');
}

function error(nodeId: string, message: string, fieldPath?: string): Problem {
  return fieldPath === undefined
    ? { nodeId, severity: 'error', message }
    : { nodeId, severity: 'error', message, fieldPath };
}

/**
 * The spec path of one node for the fallback path map: array sections get
 * `key[i]`, record sections `key.recordKey`, inline agents
 * `subagents.key.inline` and `output` the literal `output` — mirroring
 * `graphToSpec`'s `emitSection`, but tolerating duplicate record keys
 * (both duplicates report the same path, which is what the problem means).
 */
function sectionPath(key: SectionKey, prefix: string, child: GraphNode, index: number): string {
  if (key === 'output') return `${prefix}output`;
  if (key === 'mcpServers') return `${prefix}mcpServers.${(child.data as McpNodeData).key}`;
  if (key === 'subagents') {
    return child.kind === 'agent'
      ? `${prefix}subagents.${(child.data as AgentNodeData).subagentKey}.inline`
      : `${prefix}subagents.${(child.data as SubagentNodeData).key}`;
  }
  return `${prefix}${key}[${index}]`;
}

/**
 * `specPaths` without `graphToSpec`'s node-walk invariant: used when
 * `graphToSpec` throws (duplicate record keys, a second `output` node —
 * exactly the graphs this validator must still map paths for). Recursive
 * per inline agent; orphan and note nodes get no path.
 */
function tolerantSpecPaths(graph: Graph): Record<string, string> {
  const paths: Record<string, string> = {};
  const root = graph.nodes.find(
    (n) => n.id === ROOT_AGENT_ID && n.kind === 'agent' && n.owner === null && n.proposed !== 'remove'
  );
  if (root === undefined) return paths;
  const emitAgent = (agentNode: GraphNode, parentPath: string): void => {
    paths[agentNode.id] = parentPath;
    const prefix = parentPath === '' ? '' : `${parentPath}.`;
    for (const key of SECTION_ORDER) {
      if (!HANDLED_SECTIONS.has(key)) continue;
      sectionChildren(graph, agentNode.id, key).forEach((child, i) => {
        const path = sectionPath(key, prefix, child, i);
        paths[child.id] = path;
        if (key === 'subagents' && child.kind === 'agent') emitAgent(child, path);
      });
    }
  };
  emitAgent(root, '');
  return paths;
}

/** What validation needs of one `graphToSpec` emission: the spec and its `specPaths`. */
interface EmittedSpec {
  spec: AgentSpecV2;
  specPaths: Record<string, string>;
}

/**
 * `graphToSpec(graph)` memoised per graph object (WeakMap): the canvas
 * nodes, the Inspector and the Problems drawer all validate the same
 * graph, and the emission (spec + `nodeIdMap` + layout) is the expensive
 * half of `validateGraph`. `null` marks a graph `graphToSpec` refuses
 * (no root agent) so it is not retried every call. The key-order hint of
 * a `previousSpec` does not change the spec's content or paths, so the
 * cache is safe to share.
 */
const EMITTED_CACHE = new WeakMap<Graph, EmittedSpec | null>();

function emittedSpec(graph: Graph): EmittedSpec | null {
  if (EMITTED_CACHE.has(graph)) return EMITTED_CACHE.get(graph) ?? null;
  let emitted: EmittedSpec | null = null;
  try {
    const result = graphToSpec(graph);
    emitted = { spec: result.spec, specPaths: result.specPaths };
  } catch {
    emitted = null;
  }
  EMITTED_CACHE.set(graph, emitted);
  return emitted;
}


type CoreCheck = (graph: Graph, paths: Readonly<Record<string, string>>) => Problem[];

/** No `agent` node — the graph cannot be saved (`graphToSpec` throws) and the canvas has nothing to attach to. */
function noMainAgent(graph: Graph): Problem[] {
  const root = liveNodes(graph).some(
    (n) => n.id === ROOT_AGENT_ID && n.kind === 'agent' && n.owner === null
  );
  return root ? [] : [error(ROOT_AGENT_ID, 'The graph has no main agent')];
}

/** Two nodes may not share an id — ids are the layout and telemetry key. */
function duplicateNodeIds(graph: Graph): Problem[] {
  const seen = new Set<string>();
  const problems: Problem[] = [];
  for (const node of liveNodes(graph)) {
    if (seen.has(node.id)) problems.push(error(node.id, `Two nodes share the id '${node.id}'`));
    seen.add(node.id);
  }
  return problems;
}

/** A node's `owner` must name a live agent node (the subtree it belongs to). */
function missingOwner(graph: Graph): Problem[] {
  const agentIds = new Set(
    liveNodes(graph)
      .filter((n) => n.kind === 'agent')
      .map((n) => n.id)
  );
  return liveNodes(graph)
    .filter((n) => n.owner !== null && !agentIds.has(n.owner))
    .map((n) => error(n.id, 'This node belongs to an agent that no longer exists'));
}

/** Triggers, abort listeners and flow nodes only exist on the root agent. */
function rootOnlyOwner(graph: Graph): Problem[] {
  return liveNodes(graph)
    .filter((n) => ROOT_ONLY_KINDS.has(n.kind) && n.owner !== ROOT_AGENT_ID)
    .map((n) => error(n.id, 'Only the main agent can have this'));
}

/** Groups of ≥ 2 nodes sharing `keyOf` — each member of a group gets a problem. */
function duplicateGroups(
  nodes: GraphNode[],
  keyOf: (node: GraphNode) => string | undefined
): GraphNode[][] {
  const byKey = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const key = keyOf(node);
    if (key === undefined) continue;
    const group = byKey.get(key) ?? [];
    group.push(node);
    byKey.set(key, group);
  }
  return [...byKey.values()].filter((group) => group.length > 1);
}

/** Two `mcp` nodes of one owner sharing `data.key` would collapse into one `mcpServers` entry. */
function duplicateMcpKeys(graph: Graph, paths: Readonly<Record<string, string>>): Problem[] {
  const nodes = liveNodes(graph).filter((n) => n.kind === 'mcp');
  return duplicateGroups(nodes, (n) => `${n.owner} ${(n.data as McpNodeData).key}`).flatMap((group) =>
    group.map((n) =>
      error(n.id, `Two MCP servers are named '${(n.data as McpNodeData).key}'`, paths[n.id])
    )
  );
}

/** The `subagents` record key a node stands for (`order.ts`'s `subagentEntryKey`). */
const subagentKey = subagentEntryKey;

/** Two `subagents` entries of one owner sharing a key would collapse into one record entry. */
function duplicateSubagentKeys(graph: Graph, paths: Readonly<Record<string, string>>): Problem[] {
  const nodes = liveNodes(graph).filter((n) => subagentKey(n) !== undefined);
  return duplicateGroups(nodes, (n) => `${n.owner} ${subagentKey(n)}`).flatMap((group) =>
    group.map((n) => error(n.id, `Two subagents are named '${subagentKey(n)}'`, paths[n.id]))
  );
}

/** Two `memory` nodes of one owner sharing `item.name` address the same memory slot. */
function duplicateMemoryNames(graph: Graph, paths: Readonly<Record<string, string>>): Problem[] {
  const nodes = liveNodes(graph).filter((n) => n.kind === 'memory');
  return duplicateGroups(nodes, (n) => `${n.owner} ${(n.data as MemoryNodeData).item.name}`).flatMap(
    (group) =>
      group.map((n) => {
        const path = paths[n.id];
        return error(
          n.id,
          `Two memory slots are named '${(n.data as MemoryNodeData).item.name}'`,
          path === undefined ? undefined : `${path}.name`
        );
      })
  );
}

/** Item ids that must be unique across the whole graph, per kind (not per owner). */
const ITEM_ID_LABELS: Partial<Record<NodeKind, string>> = {
  guardrail: 'guardrails',
  permission: 'permission rules',
  hook: 'hooks',
  trigger: 'triggers',
  abort: 'abort listeners',
};

/** The `item.id` of id-bearing kinds; other kinds have no item id. */
function itemId(node: GraphNode): string | undefined {
  if (!(node.kind in ITEM_ID_LABELS)) return undefined;
  return (node.data as { item: { id?: string } }).item.id;
}

/** Guardrail, permission, hook, trigger and abort ids are unique per kind across the graph. */
function duplicateItemIds(graph: Graph, paths: Readonly<Record<string, string>>): Problem[] {
  const problems: Problem[] = [];
  for (const kind of Object.keys(ITEM_ID_LABELS) as NodeKind[]) {
    const label = ITEM_ID_LABELS[kind];
    const nodes = liveNodes(graph).filter((n) => n.kind === kind);
    for (const group of duplicateGroups(nodes, itemId)) {
      for (const n of group) {
        const path = paths[n.id];
        problems.push(
          error(
            n.id,
            `Two ${label} use the id '${itemId(n)}'`,
            path === undefined ? undefined : `${path}.id`
          )
        );
      }
    }
  }
  return problems;
}

/** A spec carries at most one `output` per agent. */
function duplicateOutputs(graph: Graph, paths: Readonly<Record<string, string>>): Problem[] {
  const nodes = liveNodes(graph).filter((n) => n.kind === 'output');
  return duplicateGroups(nodes, (n) => n.owner ?? '').flatMap((group) =>
    group.map((n) => error(n.id, 'An agent can have only one output schema', paths[n.id]))
  );
}

/** One function per core-check row, in table order. */
const CORE_CHECKS: readonly CoreCheck[] = [
  noMainAgent,
  duplicateNodeIds,
  missingOwner,
  rootOnlyOwner,
  duplicateMcpKeys,
  duplicateSubagentKeys,
  duplicateMemoryNames,
  duplicateItemIds,
  duplicateOutputs,
];

/** Checks whose problems are graph-level (emitted before any node problem). */
const GRAPH_LEVEL: ReadonlySet<CoreCheck> = new Set([noMainAgent]);

const SEVERITY_RANK: Record<Problem['severity'], number> = { error: 0, warning: 1 };

/** Options of {@link validateGraph}. */
export interface ValidateGraphOptions {
  /**
   * Also run `agentSpecV2Schema` over the emitted spec and map each zod
   * issue to its node (`schemaIssues.ts`). Default `true`; `false` keeps
   * only the structural + per-kind checks (the kind-rule unit tests use
   * it so their fixtures stay schema-agnostic).
   */
  schema?: boolean;
}

/** A schema problem is dropped when a structural/kind problem already reports the same node and field path. */
function isDuplicate(problem: Problem, existing: readonly Problem[]): boolean {
  const fieldPath = problem.fieldPath ?? '';
  return existing.some((p) => p.nodeId === problem.nodeId && (p.fieldPath ?? '') === fieldPath);
}

/**
 * Structural + per-kind validation: the core check rows, then
 * `KIND_RULES[kind].validate` per node in `orderedNodes` order, then —
 * unless `options.schema === false` — the AgentSpec v2 schema issues
 * mapped onto nodes (`schemaProblems`), minus the ones duplicating a
 * structural/kind problem. Result order: graph-level problems first,
 * then by node walk order, errors before warnings within a node.
 */
export function validateGraph(graph: Graph, options?: ValidateGraphOptions): Problem[] {
  const emitted = emittedSpec(graph);
  const paths = emitted?.specPaths ?? tolerantSpecPaths(graph);
  const walk = orderedNodes(graph);
  const graphLevel: Problem[] = [];
  const nodeLevel: Problem[] = [];
  for (const check of CORE_CHECKS) {
    (GRAPH_LEVEL.has(check) ? graphLevel : nodeLevel).push(...check(graph, paths));
  }
  for (const node of walk) {
    const validate = KIND_RULES[node.kind]?.validate as
      | ((n: GraphNode, g: Graph) => Problem[])
      | undefined;
    if (validate !== undefined) nodeLevel.push(...validate(node, graph));
  }
  if (options?.schema !== false && emitted !== null) {
    for (const problem of schemaProblems(emitted.spec, emitted.specPaths)) {
      if (!isDuplicate(problem, nodeLevel)) nodeLevel.push(problem);
    }
  }
  const rank = new Map(walk.map((n, i) => [n.id, i]));
  const rankOf = (p: Problem): number => rank.get(p.nodeId) ?? Number.MAX_SAFE_INTEGER;
  nodeLevel.sort(
    (a, b) => rankOf(a) - rankOf(b) || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  );
  return [...graphLevel, ...nodeLevel];
}
