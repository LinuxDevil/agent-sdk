import type { ElkNode } from 'elkjs/lib/elk-api';
import { deriveEdges } from '../graph/v2/edges';
import type { Graph, GraphNode, GraphPosition } from '../graph/v2/types';
import { ROOT_AGENT_ID } from '../graph/v2/types';

/** Which nodes an auto-layout run may move: everything, or only `graph.unplaced`. */
export type LayoutScope = 'all' | 'unplaced';

/** A node's canvas size; `sizes[id]` (React Flow measured) wins over the `.rf-node` default. */
export interface NodeSize {
  width: number;
  height: number;
}

/** `.rf-node`'s fixed card size (agents.css); notes are shorter. */
const NODE_SIZE: NodeSize = { width: 208, height: 96 };
const NOTE_SIZE: NodeSize = { width: 208, height: 80 };

/** ELK options on the root graph and on every group node (elkjs replaces dagre, C17). */
const LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.spacing.nodeNode': '40',
  'elk.layered.spacing.nodeNodeBetweenLayers': '48',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
};
/** Groups add top padding for the group header drawn over the child's area. */
const GROUP_OPTIONS: Record<string, string> = {
  ...LAYOUT_OPTIONS,
  'elk.padding': '[top=56,left=24,bottom=24,right=24]',
};

/** A layout request is abandoned after this long (the worker may still answer; the reply is dropped). */
const LAYOUT_TIMEOUT_MS = 5000;

/** True for an inline subagent: the `agent` node that renders as a collapsible group. */
function isGroupNode(node: GraphNode): boolean {
  return node.kind === 'agent' && node.owner !== null;
}

/**
 * Pure: `Graph` → ELK JSON graph. The elk tree mirrors the owner tree:
 * top-level nodes (owner `null`/`agent`) are the root's children, children
 * of an expanded inline agent are ELK children of that group, and a
 * collapsed group is a leaf (its descendants stay out, keeping their
 * positions). Notes take part so the layout sees them, but
 * `applyElkPositions` never moves them. Edges are `deriveEdges(graph)`
 * minus any whose endpoints are hidden (not in the elk tree).
 */
export function toElkGraph(graph: Graph, sizes: Record<string, NodeSize> = {}): ElkNode {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  /**
   * The elk parent of `node`: `null` for the root level, the group id for a
   * child of an expanded inline agent, `undefined` for a node hidden inside
   * a collapsed group (or owned by something that is not a group).
   */
  const elkParent = (node: GraphNode): string | null | undefined => {
    if (node.owner === null || node.owner === ROOT_AGENT_ID) return null;
    const owner = byId.get(node.owner);
    if (owner === undefined || !isGroupNode(owner)) return null;
    return owner.collapsed === true ? undefined : node.owner;
  };

  const included = new Set<string>();
  const childrenOf = (parent: string | null): ElkNode[] => {
    const out: ElkNode[] = [];
    for (const node of graph.nodes) {
      if (elkParent(node) !== parent) continue;
      included.add(node.id);
      const size = sizes[node.id] ?? (node.kind === 'note' ? NOTE_SIZE : NODE_SIZE);
      const elk: ElkNode = { id: node.id, width: size.width, height: size.height };
      if (isGroupNode(node)) {
        elk.layoutOptions = GROUP_OPTIONS;
        // A collapsed group is a leaf: its children keep their positions.
        if (node.collapsed !== true) {
          const children = childrenOf(node.id);
          if (children.length > 0) elk.children = children;
        }
      }
      out.push(elk);
    }
    return out;
  };

  const root: ElkNode = {
    id: 'canvas',
    layoutOptions: LAYOUT_OPTIONS,
    children: childrenOf(null),
  };

  const edges = deriveEdges(graph)
    .filter((e) => included.has(e.source) && included.has(e.target))
    .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] }));
  if (edges.length > 0) root.edges = edges;

  return root;
}

/**
 * Pure: apply ELK output positions back onto `graph`. ELK's `x`/`y` are
 * top-left corners; root-level nodes get absolute positions and a group's
 * children get positions relative to the group — exactly what React Flow
 * sub-flows expect, so nothing is converted. Only nodes in `scope` move:
 * `'all'` moves every non-note node ELK positioned, `'unplaced'` only the
 * ids in `graph.unplaced` (which then clears). Data, ids and edges are
 * never touched.
 */
export function applyElkPositions(graph: Graph, laidOut: ElkNode, scope: LayoutScope): Graph {
  const positions = new Map<string, GraphPosition>();
  const walk = (node: ElkNode): void => {
    for (const child of node.children ?? []) {
      positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
      walk(child);
    }
  };
  walk(laidOut);

  const unplaced = new Set(graph.unplaced);
  const moved = new Set<string>();
  const nodes = graph.nodes.map((node) => {
    if (node.kind === 'note') return node;
    const position = positions.get(node.id);
    if (position === undefined) return node;
    if (scope === 'unplaced' && !unplaced.has(node.id)) return node;
    moved.add(node.id);
    return { ...node, position };
  });

  return {
    ...graph,
    nodes,
    unplaced: scope === 'unplaced' ? [] : graph.unplaced.filter((id) => !moved.has(id)),
  };
}

/**
 * Applies the positions `laidOut` produced (relative to `before`) onto
 * `latest` — the graph as it is NOW, which may have been edited while the
 * async layout ran. Only nodes whose position actually changed are
 * touched, and only while `latest` still holds `before`'s position for
 * them (a node the user moved mid-layout keeps their position); node
 * data, ids, edges and unrelated `unplaced` entries always come from
 * `latest`. `unplaced` loses the moved ids — they have real positions
 * now, whether the layout or the user gave them. Returns `latest` itself
 * when nothing would move, so callers can skip a no-op `setGraph`.
 */
export function applyLayoutResult(before: Graph, laidOut: Graph, latest: Graph): Graph {
  const beforePos = new Map(before.nodes.map((n) => [n.id, n.position]));
  const laidPos = new Map(laidOut.nodes.map((n) => [n.id, n.position]));
  const moved = new Set<string>();
  for (const [id, position] of laidPos) {
    const old = beforePos.get(id);
    if (old !== undefined && (old.x !== position.x || old.y !== position.y)) moved.add(id);
  }
  if (moved.size === 0) return latest;
  let changed = false;
  const nodes = latest.nodes.map((node) => {
    const target = moved.has(node.id) ? laidPos.get(node.id) : undefined;
    const old = beforePos.get(node.id);
    if (target === undefined || old === undefined) return node;
    // The node moved (or was removed) while the layout ran - keep `latest`.
    if (node.position.x !== old.x || node.position.y !== old.y) return node;
    if (node.position.x === target.x && node.position.y === target.y) return node;
    changed = true;
    return { ...node, position: { x: target.x, y: target.y } };
  });
  if (!changed) return latest;
  return { ...latest, nodes, unplaced: latest.unplaced.filter((id) => !moved.has(id)) };
}

/** The worker round-trip protocol (`layout.worker.ts`): request `{ id, graph }`, reply `{ id, result | error }`. */
interface LayoutReply {
  id: number;
  result?: ElkNode;
  error?: string;
}

interface PendingLayout {
  resolve: (graph: ElkNode) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One layout worker per page, created lazily on the first request. */
let layoutWorker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingLayout>();

function settleAllPending(error: Error): void {
  for (const req of pending.values()) {
    clearTimeout(req.timer);
    req.reject(error);
  }
  pending.clear();
}

function ensureWorker(): Worker {
  if (layoutWorker !== undefined) return layoutWorker;
  const worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<LayoutReply>) => {
    const { id, result, error } = event.data;
    const req = pending.get(id);
    if (req === undefined) return;
    pending.delete(id);
    clearTimeout(req.timer);
    if (error !== undefined) req.reject(new Error(error));
    else if (result !== undefined) req.resolve(result);
    else req.reject(new Error('Layout failed'));
  };
  worker.onerror = () => {
    settleAllPending(new Error('Layout worker failed'));
    layoutWorker = undefined;
    worker.terminate();
  };
  layoutWorker = worker;
  return worker;
}

/** Post `elkGraph` to the shared worker; rejects after {@link LAYOUT_TIMEOUT_MS}. */
function layoutInWorker(elkGraph: ElkNode): Promise<ElkNode> {
  const worker = ensureWorker();
  const id = nextRequestId++;
  return new Promise<ElkNode>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Layout timed out'));
    }, LAYOUT_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, graph: elkGraph });
  });
}

/**
 * jsdom/vitest fallback: no `Worker` exists, so `elk.bundled.js`'s in-thread
 * (fake-worker) ELK does the layout on the main thread. Dynamically imported
 * so the ~1 MB bundle stays out of the main chunk (and out of tests that
 * never lay out).
 */
async function layoutInThread(elkGraph: ElkNode): Promise<ElkNode> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  try {
    return await elk.layout(elkGraph);
  } finally {
    try {
      elk.terminateWorker();
    } catch {
      // The bundled fake worker has nothing to terminate.
    }
  }
}

function runElk(elkGraph: ElkNode): Promise<ElkNode> {
  return typeof Worker === 'undefined' ? layoutInThread(elkGraph) : layoutInWorker(elkGraph);
}

/**
 * Re-lays-out `graph` with elkjs (layered, left to right, groups included)
 * off the main thread — or in-thread where `Worker` does not exist
 * (vitest/jsdom). Returns a new `Graph` with only positions changed; see
 * {@link applyElkPositions} for the scope rules. Rejects on worker errors
 * and after a 5 s timeout — callers keep the graph unchanged.
 */
export async function autoLayout(
  graph: Graph,
  scope: LayoutScope,
  sizes?: Record<string, NodeSize>
): Promise<Graph> {
  if (graph.nodes.length === 0) {
    return scope === 'unplaced' ? { ...graph, unplaced: [] } : graph;
  }
  const laidOut = await runElk(toElkGraph(graph, sizes));
  return applyElkPositions(graph, laidOut, scope);
}
