/**
 * Pure graph mutations — the only way canvas state changes (the v1 rule
 * "graphMutations.ts is the only way the canvas mutates graph state",
 * carried over to graph v2). Every function takes a `Graph` and returns a
 * new one without mutating the input. Node ids are assigned once at
 * creation and never recomputed: React Flow would remount a renamed node
 * and the Inspector would lose focus — `graphToSpec`'s `nodeIdMap` rekeys
 * ids at save time instead.
 */
import { canConnect } from './connectionRules';
import { flowChildRefs, removeFlowChild } from './flow';
import type { ConnectResult, KindRules } from './kindRules';
import { KIND_RULES } from './kindRules';
import { baseNodeId, dedupeId } from './nodeIds';
import { reownNode } from './reown';
import type { Graph, GraphNode, GraphPosition, NodeKind, NodeOfKind } from './types';
import { ROOT_AGENT_ID, ROOT_ONLY_KINDS } from './types';

/**
 * Moves a capability node to another agent, keeping its id (`nodeIdMap`
 * rekeys it at save). Implemented in `./reown` so `kinds/*.ts` connect
 * effects can share it without importing this module (which would cycle
 * through `kindRules`).
 */
export { reownNode };

/**
 * `KIND_RULES[kind]` with the kind parameter erased. Indexing the mapped
 * registry type loses the `K` → `NodeOfKind<K>` link, so callers promise
 * the node they pass is of `kind` — which they already know.
 */
function kindRules(kind: NodeKind): KindRules<NodeKind> | undefined {
  return KIND_RULES[kind] as KindRules<NodeKind> | undefined;
}

/** Input for {@link addNode}: the new node's kind and data (id and owner are assigned by the mutation). */
export interface NewNode {
  kind: NodeKind;
  data: GraphNode['data'];
}

/**
 * The owner for a node added from the palette: the selected agent, else the
 * selected node's owner, else the root agent. Root-only kinds always belong
 * to the root agent; notes have no owner.
 */
export function ownerForNewNode(graph: Graph, kind: NodeKind, selectedNodeId?: string): string | null {
  if (kind === 'note') return null;
  if (ROOT_ONLY_KINDS.has(kind)) return ROOT_AGENT_ID;
  const selected =
    selectedNodeId === undefined ? undefined : graph.nodes.find((n) => n.id === selectedNodeId);
  if (selected === undefined) return ROOT_AGENT_ID;
  return selected.kind === 'agent' ? selected.id : (selected.owner ?? ROOT_AGENT_ID);
}

let noteCounter = 0;

/**
 * Note ids are the only non-deterministic node ids (they have no spec item
 * to derive from): `note:n` + timestamp + counter, like v1's `nextNodeId`.
 */
function nextNoteId(): string {
  noteCounter += 1;
  return `note:n${Date.now().toString(36)}${noteCounter}`;
}

/**
 * Adds a node at `position` owned by `owner`. The id is
 * `dedupeId(baseNodeId(kind, data, owner))` — e.g. `tool:http`,
 * `tool:http#2`, `sub:r/tool:http` — or a `note:n…` id for notes.
 */
export function addNode(
  graph: Graph,
  input: NewNode,
  position: GraphPosition,
  owner: string | null
): { graph: Graph; nodeId: string } {
  const taken = new Set(graph.nodes.map((n) => n.id));
  const id =
    input.kind === 'note'
      ? dedupeId(nextNoteId(), taken)
      : dedupeId(baseNodeId(input.kind, input.data, owner), taken);
  const node = { id, kind: input.kind, owner, position, data: input.data } as GraphNode;
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, nodeId: id };
}

/** `rootId` plus every node whose `owner` chain reaches it (fixpoint walk — inline agents own whole subtrees). */
export function descendantsOf(graph: Graph, rootId: string): ReadonlySet<string> {
  const ids = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of graph.nodes) {
      if (node.owner !== null && ids.has(node.owner) && !ids.has(node.id)) {
        ids.add(node.id);
        grew = true;
      }
    }
  }
  return ids;
}

/**
 * Removes a node. The root agent cannot be removed (returns the same
 * `Graph` reference); removing an inline agent removes every node whose
 * owner chain reaches it, along with `emptySections`/`unplaced` entries
 * that referenced the removed subtree.
 */
/** `removed` plus every flow step reachable through the removed nodes' `FlowNodeData.children` (fixpoint). */
function withFlowDescendants(graph: Graph, removed: Set<string>): Set<string> {
  let grew = true;
  while (grew) {
    grew = false;
    const fresh = graph.nodes
      .filter((n) => n.kind === 'flow' && removed.has(n.id))
      .flatMap((n) => flowChildRefs(n).map((ref) => ref.id))
      .filter((id) => !removed.has(id));
    for (const id of fresh) {
      removed.add(id);
      grew = true;
    }
  }
  return removed;
}

/** The surviving nodes, each flow parent's references to removed steps dropped. */
function withoutRemovedRefs(graph: Graph, removed: ReadonlySet<string>): GraphNode[] {
  return graph.nodes
    .filter((n) => !removed.has(n.id))
    .map((n) => {
      if (n.kind !== 'flow') return n;
      let out: GraphNode = n;
      for (const id of removed) out = removeFlowChild(out, id);
      return out;
    });
}

export function removeNode(graph: Graph, nodeId: string): Graph {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (node === undefined || (node.id === ROOT_AGENT_ID && node.kind === 'agent')) return graph;
  const removed = withFlowDescendants(graph, new Set(descendantsOf(graph, nodeId)));
  return {
    ...graph,
    nodes: withoutRemovedRefs(graph, removed),
    emptySections: graph.emptySections.filter((section) => !removed.has(section.owner)),
    unplaced: graph.unplaced.filter((id) => !removed.has(id)),
  };
}

/**
 * Copies a node at +40,+40 with a deduped id, using
 * `KIND_RULES[kind].duplicateData` for fresh ids/names (default
 * `structuredClone`). The root agent, notes and output nodes cannot be
 * duplicated (a spec carries at most one `output` per agent);
 * children of an inline agent copy are not duplicated (C04 gives the copy
 * a fresh `subagentKey` via `agentRules.duplicateData`).
 */
export function duplicateNode(
  graph: Graph,
  nodeId: string
): { graph: Graph; nodeId: string | undefined } {
  const source = graph.nodes.find((n) => n.id === nodeId);
  if (
    source === undefined ||
    source.kind === 'note' ||
    source.kind === 'output' ||
    (source.id === ROOT_AGENT_ID && source.kind === 'agent')
  ) {
    return { graph, nodeId: undefined };
  }
  const rules = kindRules(source.kind);
  const data =
    rules?.duplicateData === undefined
      ? structuredClone(source.data)
      : rules.duplicateData(source, graph);
  const taken = new Set(graph.nodes.map((n) => n.id));
  const id = dedupeId(baseNodeId(source.kind, data, source.owner), taken);
  const clone = {
    ...source,
    id,
    data,
    position: { x: source.position.x + 40, y: source.position.y + 40 },
  } as GraphNode;
  return { graph: { ...graph, nodes: [...graph.nodes, clone] }, nodeId: id };
}

/** Moves a node to a new canvas position. */
export function moveNode(graph: Graph, nodeId: string, position: GraphPosition): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, position } : n)),
  };
}

/** Replaces a node's whole `data` object (typed by kind). */
export function setNodeData<K extends NodeKind>(
  graph: Graph,
  nodeId: string,
  data: NodeOfKind<K>['data']
): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === nodeId ? ({ ...n, data } as GraphNode) : n)),
  };
}

/**
 * `base` shallow-merged with `patch`; a `undefined` patch value deletes the
 * key. Deleting rather than storing `undefined` keeps optional fields out
 * of the emitted YAML.
 */
function mergePatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/**
 * Shallow-merges `patch` into the node's editable record: `data.item` for
 * capability nodes, `data.fields` for agent nodes, `data.step` for flow
 * nodes and `data` itself for notes. Ids are not recomputed (see module
 * doc); a `undefined` patch value deletes that key.
 */
export function patchNode(graph: Graph, nodeId: string, patch: Record<string, unknown>): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      if (n.kind === 'note') {
        const data = mergePatch(n.data as unknown as Record<string, unknown>, patch);
        return { ...n, data } as unknown as GraphNode;
      }
      const target = n.kind === 'agent' ? 'fields' : n.kind === 'flow' ? 'step' : 'item';
      const container = n.data as unknown as Record<string, unknown>;
      const base = (container[target] ?? {}) as Record<string, unknown>;
      return {
        ...n,
        data: { ...container, [target]: mergePatch(base, patch) },
      } as unknown as GraphNode;
    }),
  };
}

/**
 * Shallow-merges `patch` into a `flow` node's `data.flowMeta` — the root
 * step's `AgentFlow` wrapper fields (code, name, description, inputs,
 * agents). A `undefined` patch value deletes the key; a `flowMeta` left
 * with no keys is removed entirely so it stays out of the emitted YAML.
 * Non-flow nodes and flow nodes without `flowMeta` are returned unchanged.
 */
export function patchFlowMeta(graph: Graph, nodeId: string, patch: Record<string, unknown>): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id !== nodeId || n.kind !== 'flow') return n;
      const data = n.data;
      if (data.flowMeta === undefined) return n;
      const base = data.flowMeta as unknown as Record<string, unknown>;
      const merged = mergePatch(base, patch);
      const next: typeof data = { ...data };
      if (Object.keys(merged).length === 0) delete next.flowMeta;
      else next.flowMeta = merged as typeof data.flowMeta;
      return { ...n, data: next };
    }),
  };
}

/** Sets a group node's `collapsed` flag (persisted into `layout.json` by `graphToSpec`). */
export function setCollapsed(graph: Graph, nodeId: string, collapsed: boolean): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, collapsed } : n)),
  };
}

/**
 * The connect effect when the source kind has no `connectFrom` rule: attach
 * the target to the source's agent — the source itself when it is an agent,
 * the source's owner otherwise (tool → permission attaches the rule to the
 * tool's agent; kind tickets override this with real effects).
 */
function defaultConnect(source: GraphNode, target: GraphNode, graph: Graph): ConnectResult {
  const newOwner = source.kind === 'agent' ? source.id : (source.owner ?? ROOT_AGENT_ID);
  return { ok: true, graph: reownNode(graph, target.id, newOwner) };
}

/**
 * Attempts to connect two nodes by id: `canConnect` first (its refusal is
 * returned verbatim, so a drag the UI let through and a model-requested
 * mutation are refused by the same reason), then
 * `KIND_RULES[source.kind].connectFrom` or the default re-own effect.
 */
export function connectNodes(graph: Graph, sourceId: string, targetId: string): ConnectResult {
  const source = graph.nodes.find((n) => n.id === sourceId);
  if (source === undefined) return { ok: false, reason: `Unknown source node '${sourceId}'` };
  const target = graph.nodes.find((n) => n.id === targetId);
  if (target === undefined) return { ok: false, reason: `Unknown target node '${targetId}'` };
  const check = canConnect(source, target);
  if (!check.ok) return check;
  const connectFrom = kindRules(source.kind)?.connectFrom;
  return connectFrom === undefined
    ? defaultConnect(source, target, graph)
    : connectFrom(source, target, graph);
}
