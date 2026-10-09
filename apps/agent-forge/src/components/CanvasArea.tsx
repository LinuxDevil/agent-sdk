import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useAppState } from '../state/AppState';
import { isEditableTarget } from '../canvas/isEditableTarget';
import { NODE_TYPES, type AgentNodeData } from '../canvas/AgentNode';
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
import { isEdgeTypeAllowed } from '../graph/connectionRules';
import { PALETTE_DRAG_MIME, HOOK_DRAG_MIME } from '../canvas/dnd';
import { pickHookTemplate } from '../canvas/paletteActions';
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

function toRfNodes(
  graph: AgentGraphSpec,
  selectedNodeId: string | undefined,
  onRename: (id: string, label: string) => void,
  highlightedNodeId: string | undefined,
  breakpoints: string[]
): Node<AgentNodeData>[] {
  return graph.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position,
    selected: n.id === selectedNodeId,
    data: {
      graphNode: n,
      onRename,
      highlighted: n.id === highlightedNodeId,
      hasBreakpoint: hasBreakpointOn(n, breakpoints),
    },
  }));
}

function toRfEdges(graph: AgentGraphSpec): Edge[] {
  return graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target }));
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
 * LOU-Q3: which `AgentGraphNode` (by id) the pointer is currently over,
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
  setSelectedNodeId: SetSelectedNodeId
) {
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (changes.some((c) => c.type === 'position' && c.position)) {
        setGraph((g) => applyPositionChanges(g, changes));
      }
      const selection = lastSelectionChange(changes);
      if (selection) setSelectedNodeId(selection.selected ? selection.id : undefined);
    },
    [setGraph, setSelectedNodeId]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removed = changes.filter((c) => c.type === 'remove');
      if (removed.length === 0) return;
      setGraph((g) => removed.reduce((acc, c) => (c.type === 'remove' ? removeEdge(acc, c.id) : acc), g));
    },
    [setGraph]
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

/** Toolbar actions (auto layout, fit view, duplicate) plus the Ctrl/Cmd+D shortcut. */
function useToolbarActions(setGraph: SetGraph, selectedNodeId: string | undefined) {
  const { fitView } = useReactFlow();

  function handleAutoLayout() {
    setGraph((g) => autoLayout(g));
    window.requestAnimationFrame(() => fitView({ padding: 0.2, duration: 200 }));
  }

  function handleFitView() {
    fitView({ padding: 0.2, duration: 200 });
  }

  const handleDuplicate = useCallback(() => {
    if (!selectedNodeId) return;
    setGraph((g) => duplicateNode(g, selectedNodeId));
  }, [selectedNodeId, setGraph]);

  // Ctrl/Cmd+D duplicates the selected node - a discoverable shortcut
  // alongside the toolbar button, matching common canvas-editor conventions.
  // Eve DUI-F10: not while typing in a field (the Inspector, chat, the hook
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
    <div className="canvas-toolbar">
      <button className="btn" onClick={onAutoLayout} title="Auto layout the current graph">
        Auto layout
      </button>
      <button className="btn" onClick={onFitView} title="Fit view to graph">
        Fit view
      </button>
      <button
        className="btn"
        onClick={onDuplicate}
        disabled={!canDuplicate}
        title="Duplicate selected node (Ctrl/Cmd+D)"
      >
        Duplicate
      </button>
    </div>
  );
}

/**
 * Real ReactFlow canvas (LOU-M1/M2). `AppState.graph` is the single source
 * of truth: every handler below reads it and, on a real mutation, calls
 * `setGraph()` - ReactFlow's `nodes`/`edges` props are recomputed from
 * `graph` on every render rather than kept in separate ReactFlow-owned
 * state, so there is nowhere for the two to drift apart.
 */
function CanvasInner() {
  const { graph, setGraph, selectedNodeId, setSelectedNodeId, highlightedNodeId, debugState } = useAppState();
  const { connectError, flashError } = useConnectError();

  const onRename = useCallback(
    (nodeId: string, label: string) => {
      setGraph((g) => renameNode(g, nodeId, label));
    },
    [setGraph]
  );

  const breakpoints = debugState?.breakpoints ?? [];
  const breakpointsKey = breakpoints.join(',');
  const nodes = useMemo(
    () => toRfNodes(graph, selectedNodeId, onRename, highlightedNodeId, breakpoints),
    [graph, selectedNodeId, onRename, highlightedNodeId, breakpointsKey]
  );
  const edges = useMemo(() => toRfEdges(graph), [graph]);

  const editHandlers = useGraphEditHandlers(setGraph, selectedNodeId, setSelectedNodeId);
  const { onConnect, isValidConnection } = useConnectionHandlers(graph, setGraph, flashError);
  const { onDragOver, onDrop } = useDropHandlers(graph, setGraph, flashError);
  const { handleAutoLayout, handleFitView, handleDuplicate } = useToolbarActions(setGraph, selectedNodeId);

  return (
    <main className="canvas-wrap" aria-label="Agent graph" onDrop={onDrop} onDragOver={onDragOver}>
      <CanvasToolbar
        canDuplicate={!!selectedNodeId}
        onAutoLayout={handleAutoLayout}
        onFitView={handleFitView}
        onDuplicate={handleDuplicate}
      />
      {connectError && (
        <div className="canvas-connect-error" role="alert">
          {connectError}
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={editHandlers.onNodesChange}
        onEdgesChange={editHandlers.onEdgesChange}
        onNodesDelete={editHandlers.onNodesDelete}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
        <MiniMap position="top-right" pannable zoomable />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>
    </main>
  );
}

/**
 * Real ReactFlow-based node-graph editor (LOU-M), replacing the LOU-L1
 * placeholder. Its `ReactFlowProvider` lives in App.tsx (Eve DUI-F9) so the
 * left rail's palette can add a node at the viewport centre. `@xyflow/react` is this app's chosen package - `reactflow`
 * on npm is the predecessor name, now in maintenance mode pointing
 * adopters at `@xyflow/react` (same team, actively released); see the
 * epic's PR description for the full rationale.
 */
export function CanvasArea() {
  return <CanvasInner />;
}
