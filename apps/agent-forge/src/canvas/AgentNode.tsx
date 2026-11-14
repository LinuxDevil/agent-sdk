import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { NodeKind } from '../graph/v2/types';
import { AgentGroupNode } from './AgentGroupNode';
import { NodeCard, type CanvasNodeData } from './NodeCard';
import { NoteNode } from './NoteNode';

/**
 * The one ReactFlow node renderer for every `NodeKind`: a card built by
 * `NodeCard` (`./NodeCard.tsx` — the shared chrome the group's collapsed
 * card and head also use). Everything per-kind comes from `viewFor(kind)`
 * (the generic fallback until a kind ticket registers a `KindView`) — no
 * per-kind branches here. `CanvasNodeData` lives in `./NodeCard` and is
 * re-exported so existing imports keep working.
 */

export type { CanvasNodeData } from './NodeCard';

function AgentNodeImpl({ data, selected }: NodeProps) {
  const nodeData = data as unknown as CanvasNodeData;
  return <NodeCard data={nodeData} selected={selected} />;
}

const AgentNode = memo(AgentNodeImpl);

/**
 * The React Flow node type for a graph node. Prefixed so none
 * collides with React Flow's built-in `input`/`output`/`default`/`group`
 * types - a node typed `output` picked up `.react-flow__node-output`'s
 * default border, padding and width and was drawn double-boxed.
 */
export function flowNodeType(kind: NodeKind): string {
  return `agent-${kind}`;
}

/** The node type an inline subagent uses (expanded or collapsed — `AgentGroupNode` branches on `collapsed`). */
export const GROUP_NODE_TYPE = 'agent-group';

const NODE_KIND_LIST: NodeKind[] = [
  'agent',
  'subagent',
  'handoff',
  'tool',
  'mcp',
  'skill',
  'memory',
  'guardrail',
  'permission',
  'hook',
  'output',
  'trigger',
  'abort',
  'flow',
  'note',
];

export const NODE_TYPES: Record<string, typeof AgentNode> = {
  ...Object.fromEntries(NODE_KIND_LIST.map((kind) => [flowNodeType(kind), AgentNode])),
  // Notes render as sticky-note cards, not the shared NodeCard chrome.
  [flowNodeType('note')]: NoteNode,
  [GROUP_NODE_TYPE]: AgentGroupNode,
};

/** The MiniMap draws each node in its kind's tile colour (see `.minimap-node-*` in screens/agents/agents.css). */
export function miniMapNodeClassName(node: { data: Record<string, unknown> }): string {
  const graphNode = (node.data as Partial<CanvasNodeData>).graphNode;
  return graphNode ? `minimap-node-${graphNode.kind}` : '';
}
