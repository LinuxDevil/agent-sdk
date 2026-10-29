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
import { Copy, LayoutGrid, Maximize, PanelRightClose, PanelRightOpen, type LucideIcon } from 'lucide-react';
import { useAppState } from '../state/AppState';
import { isEditableTarget } from '../canvas/isEditableTarget';
import { NODE_TYPES, flowNodeType, miniMapNodeClassName, type AgentNodeData } from '../canvas/AgentNode';
import {
  addHookToNode,
  addNode,
  connectNodes,
  duplicateNode,
  moveNode,
  removeEdge,
  removeNode,
  renameNode,
} from '../canvas/graphMutations';
import { autoLayout } from '../canvas/layout';
import { EmptyCanvas } from '../canvas/EmptyCanvas';
import { nodeRunStatuses, type NodeRunStatus } from '../canvas/nodeStatus';
import { isEdgeTypeAllowed } from '../graph/connectionRules';
import { PALETTE_DRAG_MIME, HOOK_DRAG_MIME } from '../canvas/dnd';
import { pickHookTemplate } from '../canvas/paletteActions';
import { useAgentEdgeSelection, useFitOnLoad } from '../canvas/canvasResets';
import type { AgentGraphNode, AgentGraphNodeType, AgentGraphSpec, AgentNodeHookPhase } from '../graph/types';

type SetGraph = ReturnType<typeof useAppState>['setGraph'];
type SetSelectedNodeId = ReturnType<typeof useAppState>['setSelectedNodeId'];

function breakpointKeyForNode(n: AgentGraphSpec['nodes'][number]): string | undefined {
  if (n.type === 'llm') return 'llm:before';
  if (n.type === 'tool') return `tool:${n.data.toolName}:before`;
  return undefined;
}

function hasBreakpointOn(n: AgentGraphNode, breakpoints: string[]): boolean {
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
export function applyDimensionChanges(prev: MeasuredSizes, changes: NodeChange[]): MeasuredSizes {
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
  onRename: (id: string, label: string) => void;
  highlightedNodeId: string | undefined;
  breakpoints: string[];
  statuses: Record<string, NodeRunStatus>;
}

function toRfNodes(graph: AgentGraphSpec, decor: NodeDecor, measured: MeasuredSizes = {}): Node<AgentNodeData>[] {
  const { selectedNodeId, onRename, highlightedNodeId, breakpoints, statuses } = decor;
  // An agent's tools are all its tool nodes (graphToSpec.ts's flat `tools` list).
  const toolCount = graph.nodes.filter((n) => n.type === 'tool').length;
  return graph.nodes.map((n) => ({
    id: n.id,
    type: flowNodeType(n.type),
    position: n.position,
    selected: n.id === selectedNodeId,
    measured: measured[n.id],
    data: {
      graphNode: n,
      onRename,
      highlighted: n.id === highlightedNodeId,
      hasBreakpoint: hasBreakpointOn(n, breakpoints),
      toolCount: n.type === 'llm' ? toolCount : undefined,
      status: statuses[n.id],
    },
  }));
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
  graph: AgentGraphSpec,
  statuses: Record<string, NodeRunStatus> = {},
  selectedEdgeId?: string
): Edge[] {
  return graph.edges.map((e) => {
    const running = statuses[e.source] === 'running';
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'gapped',
      selected: e.id === selectedEdgeId,
      deletable: false,
      animated: running,
      className: running ? 'edge-running' : undefined,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: running ? 'var(--accent)' : 'var(--text-faint)' },
    };
  });
}

/** Apply every ReactFlow position change that carries a position to the graph. */
function applyPositionChanges(graph: AgentGraphSpec, changes: NodeChange[]): AgentGraphSpec {
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

/**
 * Which `AgentGraphNode` (by id) the pointer is currently over,
 * found by walking up the real DOM from `document.elementFromPoint()` to
 * the nearest element carrying AgentNode.tsx's `data-node-id` attribute.
 * Native HTML5 drag-and-drop only gives `onDrop` a client point, not
 * "which React node is under it" - ReactFlow doesn't expose that as a
 * hit-test API - so this reads it straight from the rendered DOM, the
 * same way a browser's own elementFromPoint-based drop targeting works.
 */
function nodeIdAtPoint(clientX: number, clientY: number): string | undefined {
  const el = document.elementFromPoint(clientX, clientY);
  const nodeEl = el?.closest<HTMLElement>('[data-node-id]');
  return nodeEl?.dataset.nodeId;
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
  setSelectedEdgeId: (id: string | undefined) => void
) {
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (changes.some((c) => c.type === 'position' && c.position)) {
        setGraph((g) => applyPositionChanges(g, changes));
      }
      if (changes.some((c) => c.type === 'dimensions')) {
        setMeasured((prev) => applyDimensionChanges(prev, changes));
      }
      const selection = lastSelectionChange(changes);
      if (selection) setSelectedNodeId(selection.selected ? selection.id : undefined);
    },
    [setGraph, setSelectedNodeId, setMeasured]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const select = [...changes].reverse().find((c) => c.type === 'select');
      if (select && select.type === 'select') setSelectedEdgeId(select.selected ? select.id : undefined);
      const removed = changes.filter((c) => c.type === 'remove');
      if (removed.length === 0) return;
      setGraph((g) => removed.reduce((acc, c) => (c.type === 'remove' ? removeEdge(acc, c.id) : acc), g));
    },
    [setGraph, setSelectedEdgeId]
  );

  const onNodesDelete = useCallback(
    (deleted: Node[]) => {
      setGraph((g) => deleted.reduce((acc, n) => removeNode(acc, n.id), g));
      if (deleted.some((n) => n.id === selectedNodeId)) setSelectedNodeId(undefined);
    },
    [setGraph, selectedNodeId, setSelectedNodeId]
  );

  return { onNodesChange, onEdgesChange, onNodesDelete };
}

/** Edge creation: `onConnect` commits (or flashes the rejection), `isValidConnection` gates dragging. */
function useConnectionHandlers(graph: AgentGraphSpec, setGraph: SetGraph, flashError: (reason: string) => void) {
  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
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
    [setGraph, flashError]
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      const source = graph.nodes.find((n) => n.id === connection.source);
      const target = graph.nodes.find((n) => n.id === connection.target);
      if (!source || !target) return false;
      return isEdgeTypeAllowed(source.type, target.type);
    },
    [graph]
  );

  return { onConnect, isValidConnection };
}

/** Palette/hook drag-and-drop onto the canvas. */
function useDropHandlers(graph: AgentGraphSpec, setGraph: SetGraph, flashError: (reason: string) => void) {
  const { screenToFlowPosition } = useReactFlow();

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(PALETTE_DRAG_MIME) && !e.dataTransfer.types.includes(HOOK_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const dropHook = useCallback(
    (e: DragEvent<HTMLDivElement>, hookPhase: AgentNodeHookPhase) => {
      e.preventDefault();
      const targetNodeId = nodeIdAtPoint(e.clientX, e.clientY);
      const targetNode = graph.nodes.find((n) => n.id === targetNodeId);
      if (!targetNode || (targetNode.type !== 'llm' && targetNode.type !== 'tool')) {
        flashError('Drop a hook onto an LLM or tool node to attach it');
        return;
      }
      const template = pickHookTemplate(targetNode.type, hookPhase);
      setGraph((g) => addHookToNode(g, targetNode.id, template));
    },
    [graph, setGraph, flashError]
  );

  const dropPaletteNode = useCallback(
    (e: DragEvent<HTMLDivElement>, nodeType: AgentGraphNodeType) => {
      e.preventDefault();
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setGraph((g) => addNode(g, nodeType, position));
    },
    [screenToFlowPosition, setGraph]
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      const hookPhase = e.dataTransfer.getData(HOOK_DRAG_MIME) as AgentNodeHookPhase | '';
      if (hookPhase) return dropHook(e, hookPhase);
      const nodeType = e.dataTransfer.getData(PALETTE_DRAG_MIME) as AgentGraphNodeType | '';
      if (nodeType) dropPaletteNode(e, nodeType);
    },
    [dropHook, dropPaletteNode]
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
function useFitViewOnLoad(agentId: string, graph: AgentGraphSpec, measured: MeasuredSizes): boolean {
  const fitLegibly = useLegibleFit();
  const allMeasured = graph.nodes.length > 0 && graph.nodes.every((n) => measured[n.id]);
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
function useToolbarActions(setGraph: SetGraph, selectedNodeId: string | undefined) {
  const { fitView } = useReactFlow();
  const fitLegibly = useLegibleFit();

  function handleAutoLayout() {
    setGraph((g) => autoLayout(g));
    window.requestAnimationFrame(() => fitLegibly(200));
  }

  function handleFitView() {
    fitView({ ...FIT_VIEW_OPTIONS, ...motionDuration(200) });
  }

  const handleDuplicate = useCallback(() => {
    if (!selectedNodeId) return;
    setGraph((g) => duplicateNode(g, selectedNodeId));
  }, [selectedNodeId, setGraph]);

  // Ctrl/Cmd+D duplicates the selected node - a discoverable shortcut
  // alongside the toolbar button, matching common canvas-editor conventions.
  // Not while typing in a field (the Inspector, chat, the hook
  // editor) - there the keystroke belongs to the field.
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

  return { handleAutoLayout, handleFitView, handleDuplicate };
}

/** One icon button of the canvas toolbar: `label` is its accessible name, `tooltip` its title. */
function ToolbarButton({
  Icon,
  label,
  tooltip,
  onClick,
  disabled,
}: {
  Icon: LucideIcon;
  label: string;
  tooltip: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon btn-sm"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={tooltip}
    >
      <Icon aria-hidden="true" />
    </button>
  );
}

function CanvasToolbar({
  canDuplicate,
  onAutoLayout,
  onFitView,
  onDuplicate,
}: {
  canDuplicate: boolean;
  onAutoLayout: () => void;
  onFitView: () => void;
  onDuplicate: () => void;
}) {
  return (
    <div className="canvas-toolbar" role="group" aria-label="Canvas tools">
      <ToolbarButton Icon={LayoutGrid} label="Auto layout" tooltip="Auto layout the current graph" onClick={onAutoLayout} />
      <ToolbarButton Icon={Maximize} label="Fit view" tooltip="Fit view to graph" onClick={onFitView} />
      <ToolbarButton
        Icon={Copy}
        label="Duplicate"
        tooltip="Duplicate selected node (Ctrl/Cmd+D)"
        onClick={onDuplicate}
        disabled={!canDuplicate}
      />
    </div>
  );
}

/** What the canvas needs to show the docked Inspector's Show/Hide toggle (AgentsScreen.tsx owns the state). */
export interface InspectorToggleProps {
  inspectorCollapsed?: boolean;
  onToggleInspector?: () => void;
}

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
 * Real ReactFlow canvas. `AppState.graph` is the single source
 * of truth: every handler below reads it and, on a real mutation, calls
 * `setGraph()` - ReactFlow's `nodes`/`edges` props are recomputed from
 * `graph` on every render rather than kept in separate ReactFlow-owned
 * state, so there is nowhere for the two to drift apart.
 */
/**
 * The React Flow nodes and edges derived from `graph` and the run/debug/selection
 * state, plus the measured-size and selected-edge state they depend on.
 */
function useCanvasElements() {
  const { agentId, graph, setGraph, selectedNodeId, setSelectedNodeId, highlightedNodeId, debugState, spans, runStatus } =
    useAppState();

  const onRename = useCallback(
    (nodeId: string, label: string) => {
      setGraph((g) => renameNode(g, nodeId, label));
    },
    [setGraph]
  );

  const breakpoints = debugState?.breakpoints ?? [];
  const breakpointsKey = breakpoints.join(',');
  const [measured, setMeasured] = useState<MeasuredSizes>({});
  const statuses = useMemo(() => nodeRunStatuses(graph, spans, runStatus), [graph, spans, runStatus]);
  const nodes = useMemo(
    () => toRfNodes(graph, { selectedNodeId, onRename, highlightedNodeId, breakpoints, statuses }, measured),
    [graph, selectedNodeId, onRename, highlightedNodeId, breakpointsKey, statuses, measured]
  );
  const [selectedEdgeId, setSelectedEdgeId] = useAgentEdgeSelection(agentId);
  const edges = useMemo(() => toRfEdges(graph, statuses, selectedEdgeId), [graph, statuses, selectedEdgeId]);

  return { agentId, graph, setGraph, selectedNodeId, setSelectedNodeId, nodes, edges, measured, setMeasured, setSelectedEdgeId };
}

function CanvasInner(inspectorToggle: InspectorToggleProps) {
  const { agentId, graph, setGraph, selectedNodeId, setSelectedNodeId, nodes, edges, measured, setMeasured, setSelectedEdgeId } =
    useCanvasElements();
  const { connectError, flashError } = useConnectError();

  const editHandlers = useGraphEditHandlers(setGraph, selectedNodeId, setSelectedNodeId, setMeasured, setSelectedEdgeId);
  const { onConnect, isValidConnection } = useConnectionHandlers(graph, setGraph, flashError);
  const { onDragOver, onDrop } = useDropHandlers(graph, setGraph, flashError);
  const { handleAutoLayout, handleFitView, handleDuplicate } = useToolbarActions(setGraph, selectedNodeId);
  useFitViewOnResize();
  useKeepSelectionInView(selectedNodeId);
  const fitting = useFitViewOnLoad(agentId, graph, measured);

  return (
    <main className="canvas-wrap" aria-label="Agent graph" data-fitting={fitting || undefined} onDrop={onDrop} onDragOver={onDragOver}>
      <CanvasToolbar
        canDuplicate={!!selectedNodeId}
        onAutoLayout={handleAutoLayout}
        onFitView={handleFitView}
        onDuplicate={handleDuplicate}
      />
      <InspectorToggle {...inspectorToggle} />
      <EmptyCanvas />
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
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        deleteKeyCode={['Backspace', 'Delete']}
        minZoom={MIN_ZOOM}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={2} color="var(--canvas-dot)" />
        {/* Nothing to overview or zoom on an empty canvas; the template card has the room. */}
        {graph.nodes.length > 0 && <CanvasNavigator />}
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
export function CanvasArea(props: InspectorToggleProps) {
  return <CanvasInner {...props} />;
}
