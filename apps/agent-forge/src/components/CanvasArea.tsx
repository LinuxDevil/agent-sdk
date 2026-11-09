import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  SmoothStepEdge,
  getNodesBounds,
  getViewportForBounds,
  useReactFlow,
  useStore,
  useStoreApi,
  type EdgeProps,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Copy, LayoutGrid, Maximize, PanelRightClose, PanelRightOpen, Sparkles, type LucideIcon } from 'lucide-react';
import { useAppState } from '../state/AppState';
import { isEditableTarget } from '../canvas/isEditableTarget';
import { GROUP_NODE_TYPE, NODE_TYPES, flowNodeType, miniMapNodeClassName, type CanvasNodeData } from '../canvas/AgentNode';
import {
  addNode,
  connectNodes,
  descendantsOf,
  duplicateNode,
  moveNode,
  ownerForNewNode,
  removeNode,
} from '../graph/v2/mutations';
import { positionFor } from '../graph/v2/reown';
import { canConnect } from '../graph/v2/connectionRules';
import { orderedNodes } from '../graph/v2/order';
import { deriveEdges } from '../graph/v2/edges';
import { proposalCounts } from '../graph/v2/proposal';
import { toolNodeName } from '../graph/v2/nodeIds';
import type { Graph, GraphEdge, GraphNode, ToolNodeData } from '../graph/v2/types';
import { ROOT_AGENT_ID, ROOT_ONLY_KINDS } from '../graph/v2/types';
import { KIND_VIEWS, type PaletteEntry } from '../canvas/kinds';
import { applyLayoutResult, autoLayout } from '../canvas/layout';
import { useToast } from '../ui/Toast';
import { EmptyCanvas } from '../canvas/EmptyCanvas';
import { nodeRunStatuses, type NodeRunStatus } from '../canvas/nodeStatus';
import { PALETTE_DRAG_MIME } from '../canvas/dnd';
import { useAgentEdgeSelection, useFitOnLoad } from '../canvas/canvasResets';

type SetGraph = ReturnType<typeof useAppState>['setGraph'];
type SetSelectedNodeId = ReturnType<typeof useAppState>['setSelectedNodeId'];

function breakpointKeyForNode(n: GraphNode): string | undefined {
  if (n.kind === 'agent' && n.id === ROOT_AGENT_ID) return 'llm:before';
  if (n.kind === 'tool') return `tool:${toolNodeName((n.data as ToolNodeData).item)}:before`;
  return undefined;
}

function hasBreakpointOn(n: GraphNode, breakpoints: string[]): boolean {
  const key = breakpointKeyForNode(n);
  return !!key && breakpoints.includes(key);
}

/**
 * Each node's DOM size as React Flow measured it. The canvas is
 * controlled (nodes are rebuilt from `graph` every render), so the
 * `dimensions` changes React Flow reports must be fed back as `measured` -
 * without it the MiniMap has no node sizes and draws nothing.
 */
type MeasuredSizes = Record<string, { width: number; height: number }>;

/** Folds a batch of `dimensions` changes into the measured-size map (same object when nothing changed). */
function applyDimensionChanges(prev: MeasuredSizes, changes: NodeChange[]): MeasuredSizes {
  let next = prev;
  for (const change of changes) {
    if (change.type !== 'dimensions' || !change.dimensions) continue;
    const { width, height } = change.dimensions;
    const old = next[change.id];
    if (old && old.width === width && old.height === height) continue;
    next = { ...next, [change.id]: { width, height } };
  }
  return next;
}

/** What each card shows beyond its own graph node: selection, highlight, breakpoints and run status. */
interface NodeDecor {
  selectedNodeId: string | undefined;
  highlightedNodeId: string | undefined;
  breakpoints: string[];
  statuses: Record<string, NodeRunStatus>;
  /** Opens the node spans sheet for a card's status pill (AppState.openNodeSpans). */
  openNodeSpans?: (nodeId: string) => void;
}

/** True when an `owner`-chain ancestor of `node` is a collapsed agent group. */
function hasCollapsedAncestor(graph: Graph, node: GraphNode): boolean {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  let owner = node.owner;
  while (owner !== null) {
    const ownerNode = byId.get(owner);
    if (ownerNode === undefined) return false;
    if (ownerNode.kind === 'agent' && ownerNode.collapsed === true) return true;
    owner = ownerNode.owner;
  }
  return false;
}

/**
 * The graph's nodes in React-Flow order: parents before children
 * (sub-flows require it) — `orderedNodes` already walks an inline agent
 * before its children; notes and any node outside the canonical walk are
 * appended (they have no parent).
 */
function canvasNodeOrder(graph: Graph): GraphNode[] {
  const ordered = orderedNodes(graph);
  const seen = new Set(ordered.map((n) => n.id));
  return [...ordered, ...graph.nodes.filter((n) => !seen.has(n.id) && n.proposed !== 'remove')];
}

/** True for an inline subagent: the `agent` node that renders as a collapsible group. */
function isGroupNode(node: GraphNode): boolean {
  return node.kind === 'agent' && node.owner !== null;
}

/** How many nodes a collapsed group hides (its whole owner-chain subtree, minus the group itself). */
function descendantCount(graph: Graph, groupId: string): number {
  return descendantsOf(graph, groupId).size - 1;
}

/** An expanded group's minimum size and the padding kept around its children. */
const GROUP_MIN_SIZE = { width: 280, height: 160 };
const GROUP_PADDING = 24;
/** A child's assumed size before React Flow measures it (matches `.rf-node`'s fixed card). */
const ESTIMATED_NODE_SIZE = { width: 208, height: 80 };

/** The owner-chain depth of a node (an immediate subagent of the root is 1) — used to size nested groups inside-out. */
function ownerDepth(graph: Graph, node: GraphNode): number {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  let depth = 0;
  let owner = node.owner;
  while (owner !== null) {
    depth += 1;
    owner = byId.get(owner)?.owner ?? null;
  }
  return depth;
}

/**
 * The `style` size of every expanded group: the bounds of its visible
 * children (measured where React Flow has seen them, estimated otherwise —
 * nested groups use their own computed size) plus GROUP_PADDING, never
 * smaller than GROUP_MIN_SIZE. Computed deepest-first so a nested group's
 * size is known when the outer group's bounds need it.
 */
function groupSizes(graph: Graph, measured: MeasuredSizes): Map<string, { width: number; height: number }> {
  const groups = graph.nodes
    .filter((node) => isGroupNode(node) && node.collapsed !== true)
    .sort((a, b) => ownerDepth(graph, b) - ownerDepth(graph, a));
  const sizes = new Map<string, { width: number; height: number }>();
  for (const group of groups) {
    let maxX = 0;
    let maxY = 0;
    for (const child of graph.nodes) {
      if (child.owner !== group.id || hasCollapsedAncestor(graph, child)) continue;
      const size = sizes.get(child.id) ?? measured[child.id] ?? ESTIMATED_NODE_SIZE;
      maxX = Math.max(maxX, child.position.x + size.width);
      maxY = Math.max(maxY, child.position.y + size.height);
    }
    sizes.set(group.id, {
      width: Math.max(GROUP_MIN_SIZE.width, maxX + GROUP_PADDING),
      height: Math.max(GROUP_MIN_SIZE.height, maxY + GROUP_PADDING),
    });
  }
  return sizes;
}

/**
 * The React Flow nodes for `graph`: parents before children (React Flow
 * requires it), inline agents as `agent-group` nodes with a `style` size,
 * children of a collapsed group `hidden` but still `parentId`'d (without
 * the parent React Flow would re-lay them at absolute coordinates).
 */
export function toRfNodes(graph: Graph, decor: NodeDecor, measured: MeasuredSizes = {}): Node<CanvasNodeData>[] {
  const { selectedNodeId, highlightedNodeId, breakpoints, statuses, openNodeSpans } = decor;
  const sizes = groupSizes(graph, measured);
  return canvasNodeOrder(graph).map((n) => {
    const group = isGroupNode(n);
    const size = group && n.collapsed !== true ? sizes.get(n.id) : undefined;
    return {
      id: n.id,
      type: group ? GROUP_NODE_TYPE : flowNodeType(n.kind),
      // React Flow sub-flows: children of an inline agent sit inside its group.
      parentId: n.owner !== null && n.owner !== ROOT_AGENT_ID ? n.owner : undefined,
      position: n.position,
      selected: n.id === selectedNodeId,
      hidden: hasCollapsedAncestor(graph, n),
      measured: measured[n.id],
      ...(size === undefined ? {} : { style: size }),
      data: {
        graphNode: n,
        graph,
        highlighted: n.id === highlightedNodeId,
        hasBreakpoint: hasBreakpointOn(n, breakpoints),
        status: statuses[n.id],
        onViewSpans: openNodeSpans,
        insideCount: group ? descendantCount(graph, n.id) : undefined,
      },
    };
  });
}

/** How far short of the target port an edge stops, so its arrowhead never covers the port. */
const ARROW_GAP = 5;

/** A smoothstep edge that ends `ARROW_GAP` px before its (left-hand) target port. */
function GappedSmoothStepEdge(props: EdgeProps) {
  return <SmoothStepEdge {...props} targetX={props.targetX - ARROW_GAP} />;
}

const EDGE_TYPES = { gapped: GappedSmoothStepEdge };

/** The toolbar's and the Controls' Fit view: the whole graph, never zoomed in past 1:1. */
const FIT_VIEW_OPTIONS = { padding: 0.15, maxZoom: 1 };

/**
 * The automatic fits (on load, on resize, after auto layout) stop zooming out
 * here, so node text stays legible (13px titles render at >= ~10px); a graph
 * too big for the pane at this zoom opens pinned to its top-left corner (where
 * the trigger sits) instead of centred. The user can still zoom out to
 * MIN_ZOOM, or press Fit view.
 */
const AUTO_FIT_MIN_ZOOM = 0.75;
/** The inset (screen px) of a pinned graph's left/top edge. */
const AUTO_FIT_INSET = 40;
/**
 * The automatic fits' margin round the graph: a fixed 32 screen px rather
 * than Fit view's proportional 15%, which would cost the default four-stage
 * graph ~0.1 of zoom in a 1280px-wide builder (the difference between
 * fitting whole above AUTO_FIT_MIN_ZOOM and being cut off).
 */
const AUTO_FIT_PADDING = '32px';

/**
 * React Flow's default floor (0.5) is too high for a 4-column graph in the
 * builder's ~540px pane at 1280px wide: the fit stopped at 0.5 and cut the
 * trigger off. A whole graph in view beats a zoom floor.
 */
const MIN_ZOOM = 0.2;

/**
 * Smoothstep edges ending in a closed arrow. An edge whose source node is
 * running is animated in the accent colour (`.edge-running` in agents.css;
 * reduced motion keeps the colour and drops the dash animation). The selected
 * edge (`selectedEdgeId`) is drawn in the accent colour. Edges are selectable
 * but not deletable on their own (as before): removing a node still drops its edges.
 */
export function toRfEdges(
  edges: GraphEdge[],
  statuses: Record<string, NodeRunStatus> = {},
  selectedEdgeId?: string,
  hiddenNodeIds?: ReadonlySet<string>,
  proposed?: ReadonlyMap<string, GraphNode['proposed']>
): Edge[] {
  return edges.map((e) => {
    const running = statuses[e.source] === 'running';
    // The proposal overlay (C21): an edge touching an added node draws
    // dashed --success, one touching a removed node dashed --danger.
    const src = proposed?.get(e.source);
    const tgt = proposed?.get(e.target);
    const proposedClass =
      src === 'add' || tgt === 'add' ? 'edge-proposed-add' : src === 'remove' || tgt === 'remove' ? 'edge-proposed-remove' : undefined;
    const className = [running ? 'edge-running' : undefined, proposedClass].filter(Boolean).join(' ') || undefined;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'gapped',
      label: e.label,
      selected: e.id === selectedEdgeId,
      deletable: false,
      // React Flow draws an edge unless its own `hidden` flag is set - a
      // collapsed group's children keep their edges out of view this way.
      hidden: hiddenNodeIds === undefined ? false : hiddenNodeIds.has(e.source) || hiddenNodeIds.has(e.target),
      animated: running,
      className,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: running ? 'var(--accent)' : 'var(--text-faint)' },
    };
  });
}

/** Apply every ReactFlow position change that carries a position to the graph. */
function applyPositionChanges(graph: Graph, changes: NodeChange[]): Graph {
  let next = graph;
  for (const change of changes) {
    if (change.type === 'position' && change.position) {
      next = moveNode(next, change.id, change.position);
    }
  }
  return next;
}

/** The node id selected by the LAST select change in the batch, if any. */
function lastSelectionChange(changes: NodeChange[]): { id: string; selected: boolean } | undefined {
  const selectChange = [...changes].reverse().find((c) => c.type === 'select');
  return selectChange && selectChange.type === 'select' ? selectChange : undefined;
}

/** Auto-clearing "connection rejected" banner message. */
function useConnectError() {
  const [connectError, setConnectError] = useState<string | undefined>(undefined);
  const errorTimer = useRef<ReturnType<typeof setTimeout>>();

  const flashError = useCallback((reason: string) => {
    setConnectError(reason);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setConnectError(undefined), 3200);
  }, []);

  return { connectError, flashError };
}

/** Node/edge change + delete handlers that write ReactFlow edits back to `graph`. */
function useGraphEditHandlers(
  setGraph: SetGraph,
  selectedNodeId: string | undefined,
  setSelectedNodeId: SetSelectedNodeId,
  setMeasured: (updater: (prev: MeasuredSizes) => MeasuredSizes) => void,
  setSelectedEdgeId: (id: string | undefined) => void,
  readOnly: boolean
) {
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // While a proposal overlay is shown the canvas is read-only (C21):
      // position writes are refused even if a stray change slips through.
      if (!readOnly && changes.some((c) => c.type === 'position' && c.position)) {
        setGraph((g) => applyPositionChanges(g, changes));
      }
      if (changes.some((c) => c.type === 'dimensions')) {
        setMeasured((prev) => applyDimensionChanges(prev, changes));
      }
      const selection = lastSelectionChange(changes);
      if (selection) setSelectedNodeId(selection.selected ? selection.id : undefined);
    },
    [setGraph, setSelectedNodeId, setMeasured, readOnly]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      // Edges are derived from node data, never stored: only selection is
      // tracked (deletion is refused - `deletable: false` - and rewiring
      // goes through `connectNodes`, not edge removal).
      const select = [...changes].reverse().find((c) => c.type === 'select');
      if (select && select.type === 'select') setSelectedEdgeId(select.selected ? select.id : undefined);
    },
    [setSelectedEdgeId]
  );

  const onNodesDelete = useCallback(
    (deleted: Node[]) => {
      // Read-only while a proposal overlay is shown (C21): deletes never reach the graph.
      if (readOnly) return;
      // removeNode refuses the root agent silently.
      setGraph((g) => deleted.reduce((acc, n) => removeNode(acc, n.id), g));
      if (deleted.some((n) => n.id === selectedNodeId)) setSelectedNodeId(undefined);
    },
    [setGraph, selectedNodeId, setSelectedNodeId, readOnly]
  );

  return { onNodesChange, onEdgesChange, onNodesDelete };
}

/** Edge creation: `onConnect` commits (or flashes the rejection), `isValidConnection` gates dragging. */
function useConnectionHandlers(graph: Graph, setGraph: SetGraph, flashError: (reason: string) => void, readOnly: boolean) {
  const onConnect = useCallback(
    (connection: Connection) => {
      if (readOnly || !connection.source || !connection.target) return;
      let rejection: string | undefined;
      setGraph((g) => {
        const result = connectNodes(g, connection.source as string, connection.target as string);
        if (!result.ok) {
          rejection = result.reason;
          return g;
        }
        return result.graph;
      });
      if (rejection) flashError(rejection);
    },
    [setGraph, flashError, readOnly]
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      if (readOnly) return false;
      const source = graph.nodes.find((n) => n.id === connection.source);
      const target = graph.nodes.find((n) => n.id === connection.target);
      if (!source || !target) return false;
      return canConnect(source, target).ok;
    },
    [graph, readOnly]
  );

  return { onConnect, isValidConnection };
}

/** Every `PaletteEntry` across the registered kind views, for the drop lookup. */
function paletteEntry(id: string): PaletteEntry | undefined {
  return Object.values(KIND_VIEWS)
    .flatMap((view) => view?.palette ?? [])
    .find((entry) => entry.id === id);
}

/**
 * The innermost expanded inline-agent group under a client point, by DOM
 * hit-test. An expanded group carries `.rf-group[data-node-kind="agent"]`;
 * a collapsed one is a plain `.rf-node` card and the root agent's card is
 * never `.rf-group`, so only expanded inline groups match.
 * `elementsFromPoint` is topmost-first, which is the innermost match.
 */
function expandedGroupAtPoint(clientX: number, clientY: number): string | undefined {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (el instanceof HTMLElement && el.classList.contains('rf-group') && el.dataset.nodeKind === 'agent') {
      return el.dataset.nodeId;
    }
  }
  return undefined;
}

/** Palette drag-and-drop onto the canvas. */
function useDropHandlers(
  setGraph: SetGraph,
  selectedNodeId: string | undefined,
  setSelectedNodeId: SetSelectedNodeId,
  flashError: (reason: string) => void,
  readOnly: boolean
) {
  const { screenToFlowPosition } = useReactFlow();

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (readOnly || !e.dataTransfer.types.includes(PALETTE_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, [readOnly]);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (readOnly) return;
      const entryId = e.dataTransfer.getData(PALETTE_DRAG_MIME);
      if (!entryId) return;
      e.preventDefault();
      const entry = paletteEntry(entryId);
      if (!entry) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const groupId = expandedGroupAtPoint(e.clientX, e.clientY);
      let addedId: string | undefined;
      let refusal: string | undefined;
      let refusedNodeId: string | undefined;
      setGraph((g) => {
        let owner = ownerForNewNode(g, entry.kind, selectedNodeId);
        // A drop inside an expanded group attaches to it; notes stay
        // ownerless and root-only kinds stay on the root agent.
        if (groupId !== undefined && owner !== null && !ROOT_ONLY_KINDS.has(entry.kind)) owner = groupId;
        // An `unavailable` entry refuses the drop with its reason and selects
        // the node that already blocks it (e.g. the agent's output schema).
        const reason = entry.unavailable?.(g, owner);
        if (reason !== undefined) {
          refusal = reason;
          refusedNodeId = g.nodes.find(
            (n) => n.kind === entry.kind && n.owner === owner && n.proposed !== 'remove'
          )?.id;
          return g;
        }
        const result = addNode(g, entry.create(g, owner), positionFor(g, position, owner), owner);
        addedId = result.nodeId;
        return result.graph;
      });
      if (refusal !== undefined) {
        flashError(refusal);
        if (refusedNodeId !== undefined) setSelectedNodeId(refusedNodeId);
        return;
      }
      if (addedId) setSelectedNodeId(addedId);
    },
    [screenToFlowPosition, setGraph, selectedNodeId, setSelectedNodeId, flashError, readOnly]
  );

  return { onDragOver, onDrop };
}

/**
 * A viewport animation's duration, or none under `prefers-reduced-motion:
 * reduce` - every pan/fit animation on the canvas goes through this.
 */
function motionDuration(ms: number): { duration: number } | undefined {
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return reduce ? undefined : { duration: ms };
}

/**
 * Ids of nodes hidden inside a collapsed group. React Flow never renders
 * them (`hidden` in `toRfNodes`), so they never report a measured size —
 * demanding one would block the fit/unplaced-layout gates forever.
 */
export function collapsedHiddenIds(graph: Graph): Set<string> {
  const hidden = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind === 'agent' && node.collapsed === true) {
      for (const id of descendantsOf(graph, node.id)) {
        if (id !== node.id) hidden.add(id);
      }
    }
  }
  return hidden;
}

/**
 * True when every node that can render has a measured size. Nodes hidden
 * inside a collapsed group are exempt: they are not rendered, so React
 * Flow never measures them.
 */
export function allVisibleMeasured(graph: Graph, measured: MeasuredSizes): boolean {
  const hidden = collapsedHiddenIds(graph);
  return graph.nodes.every((n) => hidden.has(n.id) || measured[n.id] !== undefined);
}

/**
 * An automatic fit: the whole graph when it fits at AUTO_FIT_MIN_ZOOM or more
 * (never past 1:1), else that zoom with the graph's top-left corner in view.
 */
function useLegibleFit() {
  const { getNodes, setViewport } = useReactFlow();
  const store = useStoreApi();
  return useCallback(
    (duration?: number) => {
      const nodes = getNodes();
      const { width, height } = store.getState();
      if (nodes.length === 0 || !width || !height) return;
      const bounds = getNodesBounds(nodes);
      const fit = getViewportForBounds(bounds, width, height, AUTO_FIT_MIN_ZOOM, 1, AUTO_FIT_PADDING);
      const x = bounds.width * fit.zoom > width ? AUTO_FIT_INSET - bounds.x * fit.zoom : fit.x;
      const y = bounds.height * fit.zoom > height ? AUTO_FIT_INSET - bounds.y * fit.zoom : fit.y;
      void setViewport({ x, y, zoom: fit.zoom }, duration ? motionDuration(duration) : undefined);
    },
    [getNodes, setViewport, store]
  );
}

/**
 * Refit the graph when the window is resized (e.g. rotating a
 * phone, or crossing the narrow-layout breakpoint), so it never sits
 * off-screen in a pane that changed size. Debounced to the last resize.
 */
function useFitViewOnResize() {
  const fitLegibly = useLegibleFit();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    function onResize() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fitLegibly(150), 150);
    }
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (timer) clearTimeout(timer);
    };
  }, [fitLegibly]);
}

/** The first fit when an agent opens or an empty canvas is filled (canvas/canvasResets.ts), with legible sizing. */
function useFitViewOnLoad(agentId: string, graph: Graph, measured: MeasuredSizes): boolean {
  const fitLegibly = useLegibleFit();
  const allMeasured = graph.nodes.length > 0 && allVisibleMeasured(graph, measured);
  return useFitOnLoad(agentId, graph.nodes.length, allMeasured, fitLegibly);
}

/** A screen-space box: left/top edge and size. */
interface ScreenBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The margin (screen px) a selected node is kept from the pane's edges. */
const SELECTION_MARGIN = 24;

/** The shift along one axis that brings [start, start + size) inside [margin, pane - margin]; the start wins when it can't all fit. */
function shiftIntoRange(start: number, size: number, pane: number): number {
  if (start < SELECTION_MARGIN) return SELECTION_MARGIN - start;
  const overflow = start + size - (pane - SELECTION_MARGIN);
  return overflow > 0 ? -Math.min(overflow, start - SELECTION_MARGIN) : 0;
}

/** How far to pan (screen px) so `node` sits inside a `paneWidth` x `paneHeight` pane; zero when it already does. */
export function panIntoView(node: ScreenBox, paneWidth: number, paneHeight: number): { dx: number; dy: number } {
  return { dx: shiftIntoRange(node.left, node.width, paneWidth), dy: shiftIntoRange(node.top, node.height, paneHeight) };
}

/**
 * Selecting a node opens the Inspector, which narrows the pane from the right
 * (AgentsScreen.tsx): pan, at the same zoom, just enough to keep the selected
 * node in view - on selection and when the pane's width changes under it (the
 * Inspector opening or closing), not on height changes (dragging the bottom
 * drawer's splitter must not snap the view back).
 */
function useKeepSelectionInView(selectedNodeId: string | undefined) {
  const { getInternalNode, getViewport, setViewport } = useReactFlow();
  const store = useStoreApi();
  const paneWidth = useStore((s) => s.width);
  useEffect(() => {
    const paneHeight = store.getState().height;
    const node = selectedNodeId ? getInternalNode(selectedNodeId) : undefined;
    if (!node?.measured.width || !node.measured.height || !paneWidth || !paneHeight) return;
    const { x, y, zoom } = getViewport();
    const box = {
      left: node.internals.positionAbsolute.x * zoom + x,
      top: node.internals.positionAbsolute.y * zoom + y,
      width: node.measured.width * zoom,
      height: node.measured.height * zoom,
    };
    const { dx, dy } = panIntoView(box, paneWidth, paneHeight);
    if (dx !== 0 || dy !== 0) void setViewport({ x: x + dx, y: y + dy, zoom }, motionDuration(150));
  }, [selectedNodeId, paneWidth, store, getInternalNode, getViewport, setViewport]);
}

/** Toolbar actions (auto layout, fit view, duplicate) plus the Ctrl/Cmd+D shortcut. */
function useToolbarActions(
  setGraph: SetGraph,
  selectedNodeId: string | undefined,
  readOnly: boolean,
  graph: Graph,
  measured: MeasuredSizes,
  agentId: string
) {
  const { fitView } = useReactFlow();
  const fitLegibly = useLegibleFit();
  const toast = useToast();
  const [layoutBusy, setLayoutBusy] = useState(false);
  // The agent on screen NOW: an auto-layout that resolves after an agent
  // switch must not write agent A's positions into agent B's document.
  const latestAgentId = useRef(agentId);
  latestAgentId.current = agentId;

  // elkjs runs off the main thread (canvas/layout.ts); the button stays
  // busy until the layout lands or fails - a failure leaves the graph as is.
  const handleAutoLayout = useCallback(async () => {
    if (readOnly || layoutBusy) return;
    const before = graph;
    const forAgent = latestAgentId.current;
    setLayoutBusy(true);
    try {
      const laidOut = await autoLayout(before, 'all', measured);
      if (latestAgentId.current !== forAgent) return;
      // A no-op layout (positions already match) must not dirty the document.
      if (applyLayoutResult(before, laidOut, before) === before) return;
      // Merge the moved positions onto the LATEST graph inside the updater:
      // edits made while elkjs ran are kept, only positions change.
      setGraph((current) => applyLayoutResult(before, laidOut, current));
      window.requestAnimationFrame(() => fitLegibly(200));
    } catch {
      toast.show({ message: "Couldn't lay out the canvas.", tone: 'error' });
    } finally {
      setLayoutBusy(false);
    }
  }, [readOnly, layoutBusy, graph, measured, setGraph, fitLegibly, toast]);

  function handleFitView() {
    fitView({ ...FIT_VIEW_OPTIONS, ...motionDuration(200) });
  }

  const handleDuplicate = useCallback(() => {
    if (readOnly || !selectedNodeId) return;
    setGraph((g) => duplicateNode(g, selectedNodeId).graph);
  }, [selectedNodeId, setGraph, readOnly]);

  // Ctrl/Cmd+D duplicates the selected node - a discoverable shortcut
  // alongside the toolbar button, matching common canvas-editor conventions.
  // Not while typing in a field (the Inspector, chat) -
  // there the keystroke belongs to the field.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && !isEditableTarget(e.target)) {
        e.preventDefault();
        handleDuplicate();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleDuplicate]);

  return { handleAutoLayout, handleFitView, handleDuplicate, layoutBusy };
}

/**
 * On agent open, nodes with no saved position (`graph.unplaced`) are laid
 * out by elkjs once every node is measured (C17). Runs once per agent id
 * and writes with `{ dirty: false }`: the recomputed positions are saved
 * with the next real edit, or never — they are recomputed on every open.
 * `graph` is `undefined` while a proposal overlay shows, so the layout
 * never writes proposal nodes into the real graph.
 */
export function useLayoutUnplaced(agentId: string, graph: Graph | undefined, measured: MeasuredSizes, setGraph: SetGraph) {
  const toast = useToast();
  // The agent on screen NOW: guards the async write against an agent
  // switch that lands while elkjs is still running.
  const latestAgentId = useRef(agentId);
  latestAgentId.current = agentId;
  // The in-flight (or finished) run for this agent. Dep changes - measured
  // batches, edits - must NOT cancel it: the result is merged onto the
  // latest graph anyway, and a cancelled run would never be retried.
  const runRef = useRef<{ agentId: string; cancelled: boolean; done: boolean } | null>(null);
  const allMeasured = graph !== undefined && allVisibleMeasured(graph, measured);
  useEffect(() => {
    if (graph === undefined || graph.unplaced.length === 0 || !allMeasured) return;
    const existing = runRef.current;
    if (existing !== null && existing.agentId === agentId) {
      if (!existing.done) return; // a layout for this agent is still in flight
      // A finished run leaves only the ids ELK could not position (hidden
      // under a collapsed group) flagged in `unplaced`. When one of them
      // is visible again - the group was expanded - allow one more run.
      const hidden = collapsedHiddenIds(graph);
      const unplacedIds = new Set(graph.unplaced);
      const hasVisibleUnplaced = graph.nodes.some(
        (n) => unplacedIds.has(n.id) && n.kind !== 'note' && !hidden.has(n.id)
      );
      if (!hasVisibleUnplaced) return;
      runRef.current = null;
    }
    const run = { agentId, cancelled: false, done: false };
    runRef.current = run;
    autoLayout(graph, 'unplaced', measured).then(
      (laidOut) => {
        if (run.cancelled || latestAgentId.current !== run.agentId) return;
        // Keep `run` as the once-per-agent marker: unplaced ids ELK cannot
        // position (nodes hidden under a collapsed group) stay flagged, and
        // clearing the marker would re-run the layout on every graph change.
        run.done = true;
        // Merge the moved positions onto the LATEST graph: edits made
        // while elkjs ran are kept, only positions change.
        setGraph((current) => applyLayoutResult(graph, laidOut, current), { dirty: false });
      },
      () => {
        if (runRef.current === run) runRef.current = null;
        if (run.cancelled || latestAgentId.current !== run.agentId) return;
        // The next graph/measured change retries; the toast says why nothing moved.
        toast.show({ message: "Couldn't lay out the canvas.", tone: 'error' });
      }
    );
  }, [agentId, graph, allMeasured, measured, setGraph, toast]);

  // Only an agent switch or unmount cancels an in-flight layout - and the
  // marker is released too, so React StrictMode's dev double-mount (which
  // runs this cleanup and then re-runs the layout effect) starts a fresh
  // run instead of stranding a cancelled one. The cancelled run's result
  // is dropped by its own `cancelled` check either way.
  useEffect(() => {
    return () => {
      if (runRef.current !== null) {
        runRef.current.cancelled = true;
        runRef.current = null;
      }
    };
  }, [agentId]);
}

/** One icon button of the canvas toolbar: `label` is its accessible name, `tooltip` its title. */
function ToolbarButton({
  Icon,
  label,
  tooltip,
  onClick,
  disabled,
  busy,
}: {
  Icon: LucideIcon;
  label: string;
  tooltip: string;
  onClick: () => void;
  disabled?: boolean;
  /** A long-running action in flight: disables the button and exposes `aria-busy`. */
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon btn-sm"
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      aria-label={label}
      title={tooltip}
    >
      <Icon aria-hidden="true" />
    </button>
  );
}

/**
 * The proposal pill (AA18) at the head of the canvas toolbar while an
 * Author overlay is shown: a dashed-accent button that opens the Author
 * dock on the proposal card (`onShowProposal`, wired by AgentsScreen).
 */
function ProposalPill({ onShow }: { onShow: () => void }) {
  return (
    <button type="button" className="canvas-proposal-pill" onClick={onShow}>
      <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
      Proposed change · review in the Author
    </button>
  );
}

function CanvasToolbar({
  canDuplicate,
  readOnly,
  proposalId,
  onShowProposal,
  layoutBusy,
  onAutoLayout,
  onFitView,
  onDuplicate,
}: {
  canDuplicate: boolean;
  /** A proposal overlay is showing: edits (auto layout, duplicate) are disabled; fit view stays. */
  readOnly: boolean;
  /** AA18: the open proposal's id - with `onShowProposal`, renders the toolbar pill. */
  proposalId?: string | null;
  onShowProposal?: () => void;
  /** The elkjs auto-layout request is in flight. */
  layoutBusy: boolean;
  onAutoLayout: () => void;
  onFitView: () => void;
  onDuplicate: () => void;
}) {
  return (
    <div className="canvas-toolbar" role="group" aria-label="Canvas tools">
      {proposalId != null && onShowProposal !== undefined && <ProposalPill onShow={onShowProposal} />}
      <ToolbarButton
        Icon={LayoutGrid}
        label="Auto layout"
        tooltip={readOnly ? 'Hide the proposal to edit' : 'Auto layout the current graph'}
        onClick={onAutoLayout}
        disabled={readOnly}
        busy={layoutBusy}
      />
      <ToolbarButton Icon={Maximize} label="Fit view" tooltip="Fit view to graph" onClick={onFitView} />
      <ToolbarButton
        Icon={Copy}
        label="Duplicate"
        tooltip={readOnly ? 'Hide the proposal to edit' : 'Duplicate selected node (Ctrl/Cmd+D)'}
        onClick={onDuplicate}
        disabled={readOnly || !canDuplicate}
      />
    </div>
  );
}

/** What the canvas needs to show the docked Inspector's Show/Hide toggle (AgentsScreen.tsx owns the state). */
export interface InspectorToggleProps {
  inspectorCollapsed?: boolean;
  onToggleInspector?: () => void;
}

/** AA18's wiring from the builder screen: the open proposal's id and the "show its card" action. */
export interface CanvasProposalSyncProps {
  /** The open Author proposal's id (drives the toolbar pill); null/absent = no overlay. */
  proposalId?: string | null;
  /** Opens the Author dock and scrolls to `[data-proposal-id]` - the pill's and dashed nodes' click. */
  onShowProposal?: () => void;
}

export type CanvasAreaProps = InspectorToggleProps & CanvasProposalSyncProps;

/**
 * The docked Inspector's Show/Hide toggle, on the canvas's top-right edge
 * next to the Inspector it opens. Wide layout only (agents.css): below 860px
 * the top bar's Inspector button opens it as a drawer.
 */
function InspectorToggle({ inspectorCollapsed = false, onToggleInspector }: InspectorToggleProps) {
  if (!onToggleInspector) return null;
  const label = inspectorCollapsed ? 'Show inspector' : 'Hide inspector';
  const Icon = inspectorCollapsed ? PanelRightOpen : PanelRightClose;
  return (
    <button
      type="button"
      className={`btn btn-secondary btn-sm canvas-inspector-toggle${inspectorCollapsed ? '' : ' btn-icon'}`}
      onClick={onToggleInspector}
      aria-label={label}
      aria-expanded={!inspectorCollapsed}
      aria-controls="studio-inspector"
      title={label}
    >
      <Icon aria-hidden="true" />
      {/* Collapsed, the word makes the way back obvious; the accessible name stays "Show inspector". */}
      {inspectorCollapsed && <span aria-hidden="true">Inspector</span>}
    </button>
  );
}

/**
 * The proposal overlay's banner (C21), top-centre over the canvas: what the
 * proposal changes (counts from `proposalCounts(displayGraph)`) and a Hide
 * ghost button. Apply/Discard live on the Author's proposal card (AA16/AA18),
 * not here.
 */
export function ProposalBanner() {
  const { proposal, displayGraph, hideProposal } = useAppState();
  if (proposal === undefined) return null;
  const counts = proposalCounts(displayGraph);
  return (
    <div className="canvas-proposal-banner" role="status">
      {proposal.title !== undefined && <span className="canvas-proposal-title">{proposal.title}</span>}
      <span>
        Showing a proposed change: {counts.added} added, {counts.edited} changed, {counts.removed} removed.
      </span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={hideProposal}>
        Hide
      </button>
    </div>
  );
}

/** The MiniMap (bottom-right) and zoom/fit Controls (bottom-left), both themed in agents.css. */
function CanvasNavigator() {
  return (
    <>
      <MiniMap
        position="bottom-right"
        pannable
        zoomable
        style={{ width: 160, height: 100 }}
        nodeClassName={miniMapNodeClassName}
        nodeBorderRadius={6}
        ariaLabel="Graph overview"
      />
      <Controls position="bottom-left" orientation="vertical" showInteractive={false} />
    </>
  );
}

/**
 * The React Flow nodes and edges derived from `graph` and the run/debug/selection
 * state, plus the measured-size and selected-edge state they depend on.
 */
function useCanvasElements() {
  const {
    agentId,
    graph,
    displayGraph,
    proposal,
    hideProposal,
    setGraph,
    selectedNodeId,
    setSelectedNodeId,
    highlightedNodeId,
    debugState,
    nodeStates,
    runStatus,
    openNodeSpans,
  } = useAppState();

  const breakpoints = debugState?.breakpoints ?? [];
  const breakpointsKey = breakpoints.join(',');
  const [measured, setMeasured] = useState<MeasuredSizes>({});
  const statuses = useMemo(
    () => nodeRunStatuses(displayGraph.nodes.map((n) => n.id), nodeStates, runStatus),
    [displayGraph, nodeStates, runStatus]
  );
  const nodes = useMemo(
    () =>
      toRfNodes(
        displayGraph,
        { selectedNodeId, highlightedNodeId, breakpoints, statuses, openNodeSpans },
        measured
      ),
    [displayGraph, selectedNodeId, highlightedNodeId, breakpointsKey, statuses, openNodeSpans, measured]
  );
  const [selectedEdgeId, setSelectedEdgeId] = useAgentEdgeSelection(agentId);
  // Edges derive from the DISPLAY graph so proposal nodes are wired in;
  // `includeRemoved` keeps a removed node's edges drawn (faded) too.
  const edges = useMemo(() => {
    const hiddenNodeIds = new Set(nodes.filter((n) => n.hidden).map((n) => n.id));
    const proposed = new Map(
      displayGraph.nodes.filter((n) => n.proposed !== undefined).map((n) => [n.id, n.proposed] as const)
    );
    return toRfEdges(deriveEdges(displayGraph, { includeRemoved: true }), statuses, selectedEdgeId, hiddenNodeIds, proposed);
  }, [displayGraph, statuses, selectedEdgeId, nodes]);

  return {
    agentId,
    graph,
    displayGraph,
    proposal,
    hideProposal,
    setGraph,
    selectedNodeId,
    setSelectedNodeId,
    nodes,
    edges,
    measured,
    setMeasured,
    setSelectedEdgeId,
  };
}

/**
 * AA18: a click on a dashed (proposed) node opens the Author card it
 * belongs to - the same action as the toolbar pill. `proposed` flags only
 * exist on the display graph while an overlay is shown, so the flag check
 * alone gates the click; node selection still happens through
 * `onNodesChange`, keeping the Inspector on the proposed node.
 */
function useProposalNodeClick(onShowProposal?: () => void) {
  return useCallback(
    (_event: unknown, node: Node<CanvasNodeData>) => {
      if (node.data.graphNode.proposed !== undefined) onShowProposal?.();
    },
    [onShowProposal]
  );
}

/**
 * Real ReactFlow canvas. `AppState.graph` is the single source
 * of truth: every handler below reads it and, on a real mutation, calls
 * `setGraph()` - ReactFlow's `nodes`/`edges` props are recomputed from
 * `graph` on every render rather than kept in separate ReactFlow-owned
 * state, so there is nowhere for the two to drift apart.
 */
function CanvasInner({ inspectorCollapsed, onToggleInspector, proposalId, onShowProposal }: CanvasAreaProps) {
  const {
    agentId,
    graph,
    displayGraph,
    proposal,
    setGraph,
    selectedNodeId,
    setSelectedNodeId,
    nodes,
    edges,
    measured,
    setMeasured,
    setSelectedEdgeId,
  } = useCanvasElements();
  const { connectError, flashError } = useConnectError();
  // While a proposal overlay is shown the canvas is read-only (C21): no
  // drags, connects, drops, deletes or layout edits — selection stays on so
  // the Inspector can show the proposed node.
  const readOnly = proposal !== undefined;

  const editHandlers = useGraphEditHandlers(setGraph, selectedNodeId, setSelectedNodeId, setMeasured, setSelectedEdgeId, readOnly);
  const { onConnect, isValidConnection } = useConnectionHandlers(displayGraph, setGraph, flashError, readOnly);
  const { onDragOver, onDrop } = useDropHandlers(setGraph, selectedNodeId, setSelectedNodeId, flashError, readOnly);
  const { handleAutoLayout, handleFitView, handleDuplicate, layoutBusy } = useToolbarActions(
    setGraph,
    selectedNodeId,
    readOnly,
    graph,
    measured,
    agentId
  );
  useFitViewOnResize();
  useKeepSelectionInView(selectedNodeId);
  const fitting = useFitViewOnLoad(agentId, displayGraph, measured);
  useLayoutUnplaced(agentId, proposal === undefined ? graph : undefined, measured, setGraph);

  const onNodeClick = useProposalNodeClick(onShowProposal);

  return (
    <main className="canvas-wrap" aria-label="Agent graph" data-fitting={fitting || undefined} onDrop={onDrop} onDragOver={onDragOver}>
      <CanvasToolbar
        canDuplicate={!!selectedNodeId}
        readOnly={readOnly}
        proposalId={proposalId}
        onShowProposal={onShowProposal}
        layoutBusy={layoutBusy}
        onAutoLayout={handleAutoLayout}
        onFitView={handleFitView}
        onDuplicate={handleDuplicate}
      />
      <InspectorToggle inspectorCollapsed={inspectorCollapsed} onToggleInspector={onToggleInspector} />
      <EmptyCanvas />
      <ProposalBanner />
      {connectError && (
        <div className="canvas-connect-error" role="alert">
          {connectError}
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={editHandlers.onNodesChange}
        onEdgesChange={editHandlers.onEdgesChange}
        onNodesDelete={editHandlers.onNodesDelete}
        onNodeClick={onNodeClick}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        minZoom={MIN_ZOOM}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={2} color="var(--canvas-dot)" />
        {/* Nothing to overview or zoom on an empty canvas; the template card has the room. */}
        {displayGraph.nodes.length > 0 && <CanvasNavigator />}
      </ReactFlow>
    </main>
  );
}

/**
 * Real ReactFlow-based node-graph editor, replacing the
 * placeholder. Its `ReactFlowProvider` lives in App.tsx so the
 * left rail's palette can add a node at the viewport centre. `@xyflow/react` is this app's chosen package - `reactflow`
 * on npm is the predecessor name, now in maintenance mode pointing
 * adopters at `@xyflow/react` (same team, actively released); see the
 * epic's PR description for the full rationale.
 */
export function CanvasArea(props: CanvasAreaProps) {
  return <CanvasInner {...props} />;
}
