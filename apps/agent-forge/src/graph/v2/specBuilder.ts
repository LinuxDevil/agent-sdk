/**
 * The builder `specToGraph` fills and `graph/v2/flow.ts` extends: the node
 * list plus the layout bookkeeping (`unplaced`, fallback column counts) every
 * `spec → graph` conversion shares. It lives in a leaf module so `flow.ts`
 * can add flow-step nodes without importing `specToGraph.ts` (which imports
 * `flow.ts` — a cycle).
 */
import type { CanvasLayout } from '../../../shared/wireTypes';
import { fallbackColumn, fallbackPosition } from './fallbackLayout';
import { baseNodeId, dedupeId } from './nodeIds';
import type { EmptySection, GraphNode, NodeKind } from './types';

/** The mutable state one `specToGraph` conversion accumulates. */
export interface SpecToGraphBuilder {
  nodes: GraphNode[];
  emptySections: EmptySection[];
  unplaced: string[];
  /** Node ids issued so far — `dedupeId`'s taken set. */
  taken: Set<string>;
  /** `'owner/column'` → how many fallback positions that column already gave out. */
  columnCounts: Map<string, number>;
  layout?: CanvasLayout;
}

/** A fresh builder for one conversion; `layout` supplies positions where it has them. */
export function createSpecBuilder(layout?: CanvasLayout): SpecToGraphBuilder {
  return {
    nodes: [],
    emptySections: [],
    unplaced: [],
    taken: new Set(),
    columnCounts: new Map(),
    layout,
  };
}

/** Position from `layout.nodes[id]`, else a fallback position plus an `unplaced` entry. */
function place(builder: SpecToGraphBuilder, node: GraphNode, inGroup: boolean): void {
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

/**
 * Deduped id + placement, then push. `specToGraph` pushes nodes in exactly
 * `orderedNodes` order; `addFlowNodes` relies on the same pre-order walk.
 */
export function addSpecNode(
  builder: SpecToGraphBuilder,
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
