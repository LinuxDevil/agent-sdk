/**
 * The proposal overlay (C21): folds a proposed `AgentSpecV2` over the
 * current canvas `Graph` into ONE display graph — never mutating either —
 * so the canvas can draw the proposal dashed on top of the live spec.
 *
 * Classification is by node id after rekeying the current graph through
 * `graphToSpec`'s `nodeIdMap` (C02), so an unsaved rename reads as an edit,
 * not a remove + add:
 *
 * - id only in the proposed spec      → the proposed node with `proposed: 'add'`
 * - id only in the current graph      → the current node with `proposed: 'remove'`
 * - id in both, data differs (deep)   → the proposed node with `proposed: 'edit'`
 * - id in both, same data             → the current node, unmarked
 *
 * Positions always come from the current graph (same ids keep their spot);
 * new ids keep `specToGraph`'s fallback positions and land in `unplaced`.
 * `proposed` is display-only: `graphToSpec` skips `'remove'` nodes and never
 * persists the flag, so `graphToSpec(merged).spec` is the proposed spec.
 */
import type { CanvasLayout } from '../../../shared/wireTypes';
import { graphToSpec } from './graphToSpec';
import { dedupeId } from './nodeIds';
import { specToGraph } from './specToGraph';
import type { AgentSpecV2 } from './specTypes';
import type { Graph, GraphNode } from './types';

/** A proposed spec being shown on the canvas: which proposal it is, its spec, an optional banner title. */
export interface ProposalOverlay {
  proposalId: string;
  spec: AgentSpecV2;
  title?: string;
}

/**
 * JSON with sorted object keys — the "deep, JSON-equal" node-data
 * comparison: `{a:1,b:2}` equals `{b:2,a:1}`, `undefined` object values are
 * dropped like `JSON.stringify` does.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',');
  return `{${body}}`;
}

/** Deep JSON equality of two nodes' `data`. */
function sameNodeData(a: GraphNode['data'], b: GraphNode['data']): boolean {
  return stableJson(a) === stableJson(b);
}

/** current graph node id → the id `specToGraph(graphToSpec(current).spec)` gives it (C02's rekey). */
type NodeIdMap = Record<string, string>;

/** A `proposed: 'remove'` clone plus the current node it was copied from. */
interface Removal {
  source: GraphNode;
  node: GraphNode;
}

interface MergeState {
  out: GraphNode[];
  usedIds: Set<string>;
  placed: Map<string, GraphNode>;
}

function specLayoutOf(layout: CanvasLayout): CanvasLayout {
  return {
    schemaVersion: 1,
    nodes: layout.nodes,
    notes: [],
    ...(layout.viewport !== undefined ? { viewport: { ...layout.viewport } } : {}),
  };
}

function mergedNode(p: GraphNode, c: GraphNode | undefined): GraphNode {
  if (c === undefined) return { ...p, proposed: 'add' };
  if (sameNodeData(c.data, p.data)) {
    // Unchanged: the current node's data and position, under the proposed
    // (canonical) id and owner so parent/child references stay consistent.
    const node: GraphNode = { ...c, id: p.id, owner: p.owner, position: { ...c.position } };
    if (c.collapsed !== undefined) node.collapsed = c.collapsed;
    return node;
  }
  // Edited: the proposed node's data, the current node's position.
  const node: GraphNode = { ...p, proposed: 'edit', position: { ...c.position } };
  if (c.collapsed !== undefined) node.collapsed = c.collapsed;
  else delete node.collapsed;
  return node;
}

function placeProposedNodes(current: Graph, proposed: Graph, rekey: NodeIdMap, state: MergeState): void {
  // rekeyed current id → the current node (for classification and position).
  const byRekeyedId = new Map<string, GraphNode>();
  for (const node of current.nodes) {
    byRekeyedId.set(rekey[node.id] ?? node.id, node);
  }
  for (const p of proposed.nodes) {
    const c = byRekeyedId.get(p.id);
    const node = mergedNode(p, c);
    state.usedIds.add(node.id);
    if (c !== undefined) state.placed.set(c.id, node);
    state.out.push(node);
  }
}

function carryNotes(current: Graph, state: MergeState): void {
  // Notes are not spec nodes: the proposal neither adds nor removes them.
  for (const note of current.nodes) {
    if (note.kind !== 'note') continue;
    const carried = { ...note, position: { ...note.position } };
    state.usedIds.add(carried.id);
    state.placed.set(note.id, carried);
    state.out.push(carried);
  }
}

function collectRemovals(current: Graph, proposed: Graph, rekey: NodeIdMap, usedIds: Set<string>): Removal[] {
  const proposedIds = new Set(proposed.nodes.map((n) => n.id));
  const removed: Removal[] = [];
  for (const c of current.nodes) {
    if (c.kind === 'note') continue;
    if (proposedIds.has(rekey[c.id] ?? c.id)) continue; // survivor — already placed
    const clone: GraphNode = { ...c, proposed: 'remove', position: { ...c.position } };
    clone.id = dedupeId(clone.id, usedIds);
    usedIds.add(clone.id);
    removed.push({ source: c, node: clone });
  }
  return removed;
}

// Insert each removal after its "previous sibling" in the current order:
// the nearest earlier same-owner node still in `out`, else the owner node
// itself, else the nearest earlier placed node, else the end.
function previousSibling(
  current: Graph,
  { source, node: clone }: Removal,
  placed: Map<string, GraphNode>
): GraphNode | undefined {
  let fallback: GraphNode | undefined;
  let ownerNode: GraphNode | undefined;
  for (let i = current.nodes.indexOf(source) - 1; i >= 0; i -= 1) {
    const s = current.nodes[i];
    const entry = placed.get(s.id);
    if (entry === undefined) continue;
    fallback ??= entry;
    if (s.owner === clone.owner) return entry;
    if (s.id === clone.owner) ownerNode ??= entry;
  }
  return ownerNode ?? fallback;
}

function insertRemoval(current: Graph, removal: Removal, out: GraphNode[], placed: Map<string, GraphNode>): void {
  const predecessor = previousSibling(current, removal, placed);
  const position = predecessor === undefined ? out.length : out.indexOf(predecessor) + 1;
  out.splice(position, 0, removal.node);
  placed.set(removal.source.id, removal.node);
}

/**
 * current graph + proposed spec → one display graph (see the module doc for
 * the classification rules). `layout` is the current document's
 * `CanvasLayout`: ids the proposal keeps take their saved position and
 * collapsed flag from it; `notes` are stripped because notes are not spec
 * nodes — the current graph's own notes carry over instead. `nodeIdMap`
 * defaults to the one `graphToSpec(current)` derives, so callers that
 * already hold it (AppState) can pass it to skip the re-derivation.
 */
export function mergeProposal(
  current: Graph,
  proposedSpec: AgentSpecV2,
  layout: CanvasLayout,
  nodeIdMap?: NodeIdMap
): Graph {
  const rekey = nodeIdMap ?? graphToSpec(current).nodeIdMap;
  const proposed = specToGraph(proposedSpec, specLayoutOf(layout));

  const out: GraphNode[] = [];
  const usedIds = new Set<string>();
  // current node id → its counterpart in `out` (survivors now, removals as
  // they are inserted, notes as carried) — the "previous sibling" lookup.
  const placed = new Map<string, GraphNode>();

  placeProposedNodes(current, proposed, rekey, { out, usedIds, placed });
  carryNotes(current, { out, usedIds, placed });
  const removed = collectRemovals(current, proposed, rekey, usedIds);
  for (const removal of removed) {
    insertRemoval(current, removal, out, placed);
  }

  const addIds = new Set(out.filter((n) => n.proposed === 'add').map((n) => n.id));
  return {
    version: 2,
    nodes: out,
    emptySections: proposed.emptySections,
    unplaced: proposed.unplaced.filter((id) => addIds.has(id)),
    ...(current.viewport !== undefined ? { viewport: { ...current.viewport } } : {}),
  };
}

/** Counts for the proposal banner. */
export function proposalCounts(merged: Graph): { added: number; removed: number; edited: number } {
  const counts = { added: 0, removed: 0, edited: 0 };
  for (const node of merged.nodes) {
    if (node.proposed === 'add') counts.added += 1;
    else if (node.proposed === 'remove') counts.removed += 1;
    else if (node.proposed === 'edit') counts.edited += 1;
  }
  return counts;
}
