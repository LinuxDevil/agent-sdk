import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useAppState } from '../state/AppState';
import { setCollapsed } from '../graph/v2/mutations';
import type { AgentNodeData as AgentData, GraphNode } from '../graph/v2/types';
import { cardClassName, NodeCard, NodeCardHead, type CanvasNodeData } from './NodeCard';
import { viewFor } from './kinds';

/**
 * The React Flow node for an inline subagent (an `agent` graph node with a
 * `subagentKey`): expanded it is a `.rf-group` container the capability
 * nodes render inside of (`parentId` + relative positions, C24/C02);
 * collapsed it is the ordinary agent card with an "N inside" chip and the
 * children hidden (`toRfNodes`). The collapse state persists to
 * `layout.json` through `graphToSpec`.
 */

/** The collapse/expand toggle in the group's head: ChevronDown while expanded, ChevronRight while collapsed. */
function CollapseButton({ node, collapsed, readOnly }: { node: GraphNode; collapsed: boolean; readOnly?: boolean }): JSX.Element {
  const { setGraph, proposal } = useAppState();
  const key = (node.data as AgentData).subagentKey ?? node.id;
  const Icon = collapsed ? ChevronRight : ChevronDown;
  // Read-only while the proposal overlay is shown (C21) or on a canvas that
  // does not own the graph (X06b): collapsing would edit a document that is
  // not the one on screen.
  const blocked = proposal !== undefined || readOnly === true;
  const blockedTitle =
    proposal !== undefined ? 'Hide the proposal to edit' : readOnly === true ? 'This canvas is read-only' : undefined;
  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon btn-sm rf-group-toggle"
      aria-expanded={!collapsed}
      disabled={blocked}
      title={blockedTitle}
      aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${key}`}
      onClick={(event) => {
        // Keep the click from selecting the node underneath the button.
        event.stopPropagation();
        if (blocked) return;
        setGraph((g) => setCollapsed(g, node.id, !collapsed));
      }}
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

function AgentGroupNodeImpl({ data, selected }: NodeProps) {
  const nodeData = data as unknown as CanvasNodeData;
  const { graphNode } = nodeData;
  const collapsed = graphNode.collapsed === true;
  const toggle = <CollapseButton node={graphNode} collapsed={collapsed} readOnly={nodeData.readOnly} />;

  if (collapsed) {
    const inside = nodeData.insideCount ?? 0;
    return <NodeCard data={nodeData} selected={selected} headAction={toggle} extraChips={[`${inside} inside`]} />;
  }

  // Ports sit level with the header row, like the plain card's.
  const { ports } = viewFor(graphNode.kind);
  return (
    <div
      className={cardClassName('rf-group', selected, nodeData)}
      data-node-kind="agent"
      data-node-id={graphNode.id}
    >
      {ports.in && <Handle type="target" position={Position.Left} className="rf-port rf-port-in" />}
      {ports.out && <Handle type="source" position={Position.Right} className="rf-port rf-port-out" />}
      <NodeCardHead
        node={graphNode}
        status={nodeData.status}
        problems={nodeData.problems}
        className="rf-group-head"
        graph={nodeData.graph}
        onViewSpans={nodeData.onViewSpans}
      >
        {/* A proposal-edited group carries the same "edited" marker chip as a card (C21). */}
        {graphNode.proposed === 'edit' && (
          <code className="node-chip node-chip-edited" title="Changed by the proposal">
            edited
          </code>
        )}
        {toggle}
      </NodeCardHead>
    </div>
  );
}

const AgentGroupNode = memo(AgentGroupNodeImpl);

/** The React Flow node type for a subagent group (registered in `AgentNode`'s `NODE_TYPES`). */
export { AgentGroupNode };
