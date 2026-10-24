/**
 * The daemon returns a trace's observations as flat rows ordered by `start`
 * (`GET /api/v1/traces/:id`); the panels nest them by `parent_obs_id`
 * client-side. Rows whose parent is missing from the set (a dropped batch,
 * a parent written after its children) are hoisted to root level rather
 * than dropped - a partial tree beats a silently empty one.
 */
import type { ObserveObservationRow } from './types';

export interface ObservationNode {
  row: ObserveObservationRow;
  children: ObservationNode[];
  /** Tree depth, roots = 0 - the waterfall indents by it. */
  depth: number;
}

function byStart(a: ObservationNode, b: ObservationNode): number {
  return a.row.start - b.row.start;
}

/**
 * Flat rows -> forest of {@link ObservationNode}s, children sorted by `start`.
 * Parent ids that don't resolve (and parent/self cycles) land at the roots.
 */
export function nestObservations(rows: ObserveObservationRow[]): ObservationNode[] {
  const ids = new Set(rows.map((row) => row.obs_id));
  const nodes = new Map<string, ObservationNode>();
  for (const row of rows) nodes.set(row.obs_id, { row, children: [], depth: 0 });

  const roots: ObservationNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.row.parent_obs_id;
    const parent = parentId !== null && ids.has(parentId) ? nodes.get(parentId) : undefined;
    if (parent === undefined || parent === node) roots.push(node);
    else parent.children.push(node);
  }

  // Depth-first pass assigns depth and sorts siblings; a parent_obs_id cycle
  // that never reaches a root is broken open at its earliest-started member.
  const seen = new Set<string>();
  const visit = (node: ObservationNode, depth: number) => {
    if (seen.has(node.row.obs_id)) return;
    seen.add(node.row.obs_id);
    node.depth = depth;
    node.children.sort(byStart);
    for (const child of node.children) visit(child, depth + 1);
  };
  roots.sort(byStart);
  for (const root of roots) visit(root, 0);
  // Cycle leftovers: reattach the cycle's earliest member at root level.
  const leftovers = rows.filter((row) => !seen.has(row.obs_id)).sort((a, b) => a.start - b.start);
  for (const row of leftovers) {
    const node = nodes.get(row.obs_id);
    if (node && !seen.has(node.row.obs_id)) {
      roots.push(node);
      visit(node, 0);
    }
  }
  return roots;
}

/** Depth-first flattening for the waterfall: each node once, in display order. */
export function flattenObservationTree(roots: ObservationNode[]): ObservationNode[] {
  const flat: ObservationNode[] = [];
  const seen = new Set<string>();
  const visit = (node: ObservationNode) => {
    // A parent_obs_id cycle nests the cycle members under each other; emit
    // each obs_id once rather than recursing through it forever.
    if (seen.has(node.row.obs_id)) return;
    seen.add(node.row.obs_id);
    flat.push(node);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return flat;
}

/** `[start, end]` bounds over every observation (an unfinished row counts to `now`). */
export function traceBounds(rows: ObserveObservationRow[], now = Date.now()): { minStart: number; maxEnd: number } {
  if (rows.length === 0) return { minStart: 0, maxEnd: 1 };
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const row of rows) {
    minStart = Math.min(minStart, row.start);
    maxEnd = Math.max(maxEnd, row.end ?? now);
  }
  return { minStart, maxEnd: Math.max(maxEnd, minStart + 1) };
}
