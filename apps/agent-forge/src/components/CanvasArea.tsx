import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useAppState } from '../state/AppState';
import { NODE_TYPES, type AgentNodeData } from '../canvas/AgentNode';
import {
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
import { PALETTE_DRAG_MIME } from '../canvas/dnd';
import type { AgentGraphNodeType, AgentGraphSpec } from '../graph/types';

function breakpointKeyForNode(n: AgentGraphSpec['nodes'][number]): string | undefined {
  if (n.type === 'llm') return 'llm:before';
  if (n.type === 'tool') return `tool:${n.data.toolName}:before`;
  return undefined;
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
      hasBreakpoint: (() => {
        const key = breakpointKeyForNode(n);
        return !!key && breakpoints.includes(key);
      })(),
    },
  }));
}

function toRfEdges(graph: AgentGraphSpec): Edge[] {
  return graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target }));
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
  const { screenToFlowPosition, fitView } = useReactFlow();
  const [connectError, setConnectError] = useState<string | undefined>(undefined);
  const errorTimer = useRef<ReturnType<typeof setTimeout>>();

  function flashError(reason: string) {
    setConnectError(reason);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setConnectError(undefined), 3200);
  }

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

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const positionChanges = changes.filter((c) => c.type === 'position' && c.position);
      if (positionChanges.length > 0) {
        setGraph((g) => {
          let next = g;
          for (const change of positionChanges) {
            if (change.type === 'position' && change.position) {
              next = moveNode(next, change.id, change.position);
            }
          }
          return next;
        });
      }
      const selectChange = [...changes].reverse().find((c) => c.type === 'select');
      if (selectChange && selectChange.type === 'select') {
        setSelectedNodeId(selectChange.selected ? selectChange.id : undefined);
      }
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
    [setGraph]
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

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(PALETTE_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      const nodeType = e.dataTransfer.getData(PALETTE_DRAG_MIME) as AgentGraphNodeType | '';
      if (!nodeType) return;
      e.preventDefault();
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setGraph((g) => addNode(g, nodeType, position));
    },
    [screenToFlowPosition, setGraph]
  );

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
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        handleDuplicate();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleDuplicate]);

  return (
    <div className="canvas-wrap" onDrop={onDrop} onDragOver={onDragOver}>
      <div className="canvas-toolbar">
        <button className="btn" onClick={handleAutoLayout} title="Auto layout the current graph">
          Auto layout
        </button>
        <button className="btn" onClick={handleFitView} title="Fit view to graph">
          Fit view
        </button>
        <button
          className="btn"
          onClick={handleDuplicate}
          disabled={!selectedNodeId}
          title="Duplicate selected node (Ctrl/Cmd+D)"
        >
          Duplicate
        </button>
      </div>
      {connectError && <div className="canvas-connect-error">{connectError}</div>}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodesDelete={onNodesDelete}
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
    </div>
  );
}

/**
 * Real ReactFlow-based node-graph editor (LOU-M), replacing the LOU-L1
 * placeholder. `@xyflow/react` is this app's chosen package - `reactflow`
 * on npm is the predecessor name, now in maintenance mode pointing
 * adopters at `@xyflow/react` (same team, actively released); see the
 * epic's PR description for the full rationale.
 */
export function CanvasArea() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
