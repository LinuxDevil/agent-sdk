import type { ReactNode } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { GraphNode } from '../graph/v2/types';
import { StatusPill } from '../ui/StatusPill';
import { viewFor } from './kinds';

/**
 * The shared card chrome of the canvas nodes: `AgentNode` renders a whole
 * card (`NodeCard`), `AgentGroupNode` renders just the head
 * (`NodeCardHead`) over the group container and a `NodeCard` when
 * collapsed. Lives in a leaf module so `AgentNode`'s `NODE_TYPES` can
 * register the group component without an import cycle.
 */

/** The `data` every canvas node carries, read by the card components. */
export interface CanvasNodeData extends Record<string, unknown> {
  graphNode: GraphNode;
  /** True when this node's log/span is the one currently selected in the drawer. */
  highlighted?: boolean;
  /** True when this node has an active breakpoint set. */
  hasBreakpoint?: boolean;
  /** This node's status in the current run (see nodeStatus.ts); omitted reads idle. */
  status?: string;
  /** Group nodes only: how many descendants the group hides while collapsed. */
  insideCount?: number;
}

/** The flag-driven class list of a card or a group container ('rf-node' / 'rf-group' + state flags). */
export function cardClassName(
  base: 'rf-node' | 'rf-group',
  selected: boolean | undefined,
  data: Pick<CanvasNodeData, 'highlighted' | 'hasBreakpoint' | 'status'>
): string {
  const flags: [string, boolean | undefined][] = [
    ['selected', selected],
    ['highlighted', data.highlighted],
    ['has-breakpoint', data.hasBreakpoint],
    ['running', data.status === 'running'],
    ['paused', data.status === 'paused'],
    ['error', data.status === 'error'],
    ['done', data.status === 'done'],
  ];
  return [base, ...flags.filter(([, on]) => on).map(([name]) => name)].join(' ');
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

/**
 * The card's header row: the kind's icon tile, the view's title and the
 * run status pill, then `children` (the group's collapse button). The
 * `rf-group-head` class hooks the same layout into the group container.
 */
export function NodeCardHead({
  node,
  status,
  className,
  children,
}: {
  node: GraphNode;
  status?: string;
  className?: string;
  children?: ReactNode;
}): JSX.Element {
  const view = viewFor(node.kind);
  const title = view.title(node as never);
  const { Icon } = view;
  return (
    <div className={['rf-node-head', className].filter(Boolean).join(' ')}>
      <span className={`node-kind kind-${view.tone}`} aria-hidden="true">
        <Icon size={14} strokeWidth={1.75} />
      </span>
      <span className="rf-node-title" title={title}>
        {title}
      </span>
      <StatusPill status={status ?? 'idle'} />
      {children}
    </div>
  );
}

/**
 * The whole node card: ports drawn with React Flow's own `<Handle>` so
 * connections attach to a real, draggable anchor, then the head, the chip
 * row and the key/value rows — all from `viewFor(node.kind)`. `headAction`
 * adds a button at the head's right edge, `extraChips` appends chips to
 * the meta row (the collapsed group's "N inside").
 */
export function NodeCard({
  data,
  selected,
  headAction,
  extraChips,
}: {
  data: CanvasNodeData;
  selected?: boolean;
  headAction?: ReactNode;
  extraChips?: string[];
}): JSX.Element {
  const { graphNode, status } = data;
  const view = viewFor(graphNode.kind);
  const chip = view.chip?.(graphNode as never);
  const rows = view.rows(graphNode as never);
  const chips = [...(chip !== undefined ? [chip] : []), ...(extraChips ?? [])];

  return (
    <div className={cardClassName('rf-node', selected, data)} data-node-kind={graphNode.kind} data-node-id={graphNode.id}>
      {view.ports.in && <Handle type="target" position={Position.Left} className="rf-port rf-port-in" />}
      {view.ports.out && <Handle type="source" position={Position.Right} className="rf-port rf-port-out" />}
      <NodeCardHead node={graphNode} status={status}>
        {headAction}
      </NodeCardHead>
      {chips.length > 0 && (
        <div className="rf-node-meta">
          {chips.map((c) => (
            <code className="node-chip" title={c} key={c}>
              {c}
            </code>
          ))}
        </div>
      )}
      <NodeRows rows={rows} />
    </div>
  );
}
