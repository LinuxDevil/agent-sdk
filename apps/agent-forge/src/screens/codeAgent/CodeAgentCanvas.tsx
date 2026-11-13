/**
 * X06b: a read-only React Flow canvas for a code-defined agent's spec. It
 * renders the `Graph` `specToGraph` + elkjs produced — the same node cards,
 * edges and MiniMap as the builder — but owns no document: there is no
 * palette, no undo, no `setGraph`. Selection still works so the Inspector
 * can show a node's fields, every one disabled (`<fieldset disabled>`, the
 * same mechanism the proposal overlay uses). Node affordances that would
 * write through `AppState` (the group collapse toggle) see
 * `CanvasNodeData.readOnly` and stay disabled.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Maximize } from 'lucide-react';
import {
  EDGE_TYPES,
  FIT_VIEW_OPTIONS,
  MIN_ZOOM,
  ToolbarButton,
  allVisibleMeasured,
  applyDimensionChanges,
  hiddenRfNodeIds,
  lastSelectionChange,
  toRfEdges,
  toRfNodes,
  type MeasuredSizes,
} from '../../components/CanvasArea';
import { NODE_TYPES, miniMapNodeClassName } from '../../canvas/AgentNode';
import { useFitOnLoad } from '../../canvas/canvasResets';
import { deriveEdges } from '../../graph/v2/edges';
import type { Graph, GraphNode, NodeKind } from '../../graph/v2/types';
import { viewFor, type KindFieldsProps } from '../../canvas/kinds';
import { EmptyInspector, InspectorHead } from '../../components/Inspector';
import { InspectorSection } from '../../components/InspectorSection';

/** The MiniMap (bottom-right) and zoom/fit Controls (bottom-left), themed by agents.css like the builder's. */
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
 * The read-only Inspector: the selected node's kind view head plus its
 * `Fields` inside a disabled fieldset, so every input renders its value
 * but accepts no edit. `patch`/`replace` are never called — the fieldset
 * blocks the gestures that would reach them. Exported for tests.
 */
export function CodeAgentInspector({ graph, node }: { graph: Graph; node: GraphNode }) {
  const view = viewFor(node.kind);
  const props: KindFieldsProps<NodeKind> = {
    node: node as never,
    graph,
    patch: () => {},
    replace: () => {},
    problems: [],
  };
  const Fields = view.Fields as (p: typeof props) => JSX.Element;
  return (
    <aside className="inspector" id="studio-inspector" aria-label="Inspector">
      <InspectorHead node={node} graph={graph} />
      <div className="inspector-body">
        <InspectorSection id="node" title="Settings">
          <fieldset disabled className="inspector-proposal-fieldset">
            <Fields {...props} />
          </fieldset>
        </InspectorSection>
      </div>
    </aside>
  );
}

/** The empty state: the shared inspector chrome with the read-only hint. */
function EmptyCodeAgentInspector() {
  return (
    <EmptyInspector hint="Select a node on the canvas to view its configuration. This agent is defined in code and is read-only." />
  );
}

/**
 * The canvas + inspector row. `agentKey` identifies the shown agent for the
 * fit-on-load bookkeeping (a new key refits, like an agent switch).
 */
export function CodeAgentCanvas({ graph, agentKey }: { graph: Graph; agentKey: string }) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  const [measured, setMeasured] = useState<MeasuredSizes>({});
  const { fitView } = useReactFlow();

  const nodes = useMemo(
    () =>
      toRfNodes(
        graph,
        {
          selectedNodeId,
          highlightedNodeId: undefined,
          breakpoints: [],
          statuses: {},
          readOnly: true,
        },
        measured
      ),
    [graph, selectedNodeId, measured]
  );

  const edges = useMemo(() => {
    return toRfEdges(deriveEdges(graph), {}, undefined, hiddenRfNodeIds(nodes));
  }, [graph, nodes]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setMeasured((prev) => applyDimensionChanges(prev, changes));
    const selection = lastSelectionChange(changes);
    if (selection !== undefined) setSelectedNodeId(selection.selected ? selection.id : undefined);
  }, []);

  const fit = useCallback(() => {
    void fitView(FIT_VIEW_OPTIONS);
  }, [fitView]);
  const fitting = useFitOnLoad(agentKey, graph.nodes.length, allVisibleMeasured(graph, measured), fit);

  const selected = graph.nodes.find((n) => n.id === selectedNodeId);
  const hasNodes = graph.nodes.length > 0;

  return (
    <div className="code-agent-canvas">
      <main className="canvas-wrap" aria-label="Agent graph" data-fitting={fitting || undefined}>
        <div className="canvas-toolbar" role="group" aria-label="Canvas tools">
          <ToolbarButton Icon={Maximize} label="Fit view" tooltip="Fit view to graph" onClick={fit} />
        </div>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          deleteKeyCode={null}
          minZoom={MIN_ZOOM}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={2} color="var(--canvas-dot)" />
          {hasNodes && <CanvasNavigator />}
        </ReactFlow>
      </main>
      {selected === undefined ? <EmptyCodeAgentInspector /> : <CodeAgentInspector graph={graph} node={selected} />}
    </div>
  );
}
