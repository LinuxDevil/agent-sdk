import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { GraphNode, NodeKind } from '../graph/v2/types';
import { StatusPill } from '../ui/StatusPill';
import { viewFor } from './kinds';

/**
 * The one ReactFlow node renderer for every `NodeKind`: a card whose
 * header carries the kind's icon tile, the view's title and the run
 * status pill; an optional mono chip under it; a body of key/value rows
 * the kind's `KindView` supplies; and left/right ports drawn with React
 * Flow's own `<Handle>` so connections attach to a real, draggable
 * anchor. Everything per-kind comes from `viewFor(kind)` (the generic
 * fallback until a kind ticket registers a `KindView`) — no per-kind
 * branches here.
 */

export interface AgentNodeData extends Record<string, unknown> {
  graphNode: GraphNode;
  /** True when this node's log/span is the one currently selected in the drawer. */
  highlighted?: boolean;
  /** True when this node has an active breakpoint set. */
  hasBreakpoint?: boolean;
  /** This node's status in the current run (see nodeStatus.ts); omitted reads idle. */
  status?: string;
}

function nodeClassName(selected: boolean | undefined, data: Pick<AgentNodeData, 'highlighted' | 'hasBreakpoint' | 'status'>): string {
  const flags: [string, boolean | undefined][] = [
    ['selected', selected],
    ['highlighted', data.highlighted],
    ['has-breakpoint', data.hasBreakpoint],
    ['running', data.status === 'running'],
  ];
  return ['rf-node', ...flags.filter(([, on]) => on).map(([name]) => name)].join(' ');
}

function NodeRows({ rows }: { rows: { k: string; v: string }[] }) {
  // No empty body box under a node with nothing to show.
  if (rows.length === 0) return null;
  return (
    <div className="rf-node-body">
      {rows.map((row) => (
        <div className="node-row" key={row.k}>
          <span>{row.k}</span>
          <code title={row.v}>{row.v}</code>
        </div>
      ))}
    </div>
  );
}

function AgentNodeImpl({ data, selected }: NodeProps) {
  const nodeData = data as unknown as AgentNodeData;
  const { graphNode, status } = nodeData;
  const view = viewFor(graphNode.kind);
  const title = view.title(graphNode as never);
  const chip = view.chip?.(graphNode as never);
  const rows = view.rows(graphNode as never);
  const { Icon } = view;

  return (
    <div className={nodeClassName(selected, nodeData)} data-node-kind={graphNode.kind} data-node-id={graphNode.id}>
      {view.ports.in && <Handle type="target" position={Position.Left} className="rf-port rf-port-in" />}
      {view.ports.out && <Handle type="source" position={Position.Right} className="rf-port rf-port-out" />}
      <div className="rf-node-head">
        <span className={`node-kind kind-${view.tone}`} aria-hidden="true">
          <Icon size={14} strokeWidth={1.75} />
        </span>
        <span className="rf-node-title" title={title}>
          {title}
        </span>
        <StatusPill status={status ?? 'idle'} />
      </div>
      {chip !== undefined && (
        <div className="rf-node-meta">
          <code className="node-chip" title={chip}>
            {chip}
          </code>
        </div>
      )}
      <NodeRows rows={rows} />
    </div>
  );
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

export const NODE_TYPES: Record<string, typeof AgentNode> = Object.fromEntries(
  NODE_KIND_LIST.map((kind) => [flowNodeType(kind), AgentNode])
);

/** The MiniMap draws each node in its kind's tile colour (see `.minimap-node-*` in screens/agents/agents.css). */
export function miniMapNodeClassName(node: { data: Record<string, unknown> }): string {
  const graphNode = (node.data as Partial<AgentNodeData>).graphNode;
  return graphNode ? `minimap-node-${graphNode.kind}` : '';
}
