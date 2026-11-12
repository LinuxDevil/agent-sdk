import type { ReactNode } from 'react';
import { Handle, Position } from '@xyflow/react';
import { CircleAlert, Pin, TriangleAlert } from 'lucide-react';
import type { Graph, GraphNode, Problem } from '../graph/v2/types';
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
  /** This node's validation problems (`validateGraph`, C19); omitted or empty draws no badge. */
  problems?: Problem[];
  /** Opens the node spans sheet for this node (AppState.openNodeSpans); omitted renders the pill inert. */
  onViewSpans?: (nodeId: string) => void;
  /** True when a tool result is pinned for this node (T04 "run from here"); renders the Pin badge. */
  pinned?: boolean;
  /** The whole graph, for kind titles that read sibling nodes (the abort listener names its trigger). */
  graph?: Graph;
  /** Group nodes only: how many descendants the group hides while collapsed. */
  insideCount?: number;
  /** `meta.enabled` of the open agent (R09); false dims non-chat trigger nodes. Absent reads enabled. */
  agentEnabled?: boolean;
}

/** The flag-driven class list of a card or a group container ('rf-node' / 'rf-group' + state flags). */
export function cardClassName(
  base: 'rf-node' | 'rf-group',
  selected: boolean | undefined,
  data: Pick<CanvasNodeData, 'highlighted' | 'hasBreakpoint' | 'status' | 'problems' | 'graphNode'>
): string {
  const flags: [string, boolean | undefined][] = [
    ['selected', selected],
    ['highlighted', data.highlighted],
    ['has-breakpoint', data.hasBreakpoint],
    ['running', data.status === 'running'],
    ['has-error', data.problems?.some((p) => p.severity === 'error')],
    ['paused', data.status === 'paused'],
    ['error', data.status === 'error'],
    ['done', data.status === 'done'],
    // The proposal overlay's marker (C21): 'proposed-add' | 'proposed-remove' | 'proposed-edit'.
    [`proposed-${data.graphNode.proposed}`, data.graphNode.proposed !== undefined],
  ];
  return [base, ...flags.filter(([, on]) => on).map(([name]) => name)].join(' ');
}

/** The worst severity among `problems` (errors outrank warnings). */
function worstSeverity(problems: readonly Problem[]): Problem['severity'] {
  return problems.some((p) => p.severity === 'error') ? 'error' : 'warning';
}

/**
 * The top-right validation badge (C19): a severity icon and the problem
 * count. Errors draw `CircleAlert` in `--danger`, warnings-only
 * `TriangleAlert` in `--warning`; the tooltip is the first message and
 * the count is the accessible name (`<n> problems`).
 */
function ProblemBadge({ problems }: { problems: readonly Problem[] }): JSX.Element | null {
  if (problems.length === 0) return null;
  const severity = worstSeverity(problems);
  const Icon = severity === 'error' ? CircleAlert : TriangleAlert;
  return (
    <span
      className={`node-problem node-problem-${severity}`}
      role="img"
      aria-label={`${problems.length} problem${problems.length === 1 ? '' : 's'}`}
      title={problems[0].message}
    >
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
      <span className="node-problem-count">{problems.length}</span>
    </span>
  );
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
  problems,
  className,
  children,
  graph,
  onViewSpans,
  pinned,
}: {
  node: GraphNode;
  status?: string;
  problems?: readonly Problem[];
  className?: string;
  children?: ReactNode;
  graph?: Graph;
  onViewSpans?: (nodeId: string) => void;
  /** Shows the "Pinned result" badge (T04) - set on tool nodes with a pin. */
  pinned?: boolean;
}): JSX.Element {
  const view = viewFor(node.kind);
  const title = view.title(node as never, graph);
  const { Icon } = view;
  const pill = <StatusPill status={status ?? 'idle'} />;
  // A node that ran (status not idle) turns its pill into the spans-sheet
  // opener; `nodrag` keeps React Flow from starting a drag on the click.
  const pillOrButton =
    onViewSpans !== undefined && (status ?? 'idle') !== 'idle' ? (
      <button
        type="button"
        className="node-status-button nodrag"
        aria-label={`View spans for ${title}`}
        onClick={(event) => {
          event.stopPropagation();
          onViewSpans(node.id);
        }}
      >
        {pill}
      </button>
    ) : (
      pill
    );
  return (
    <div className={['rf-node-head', className].filter(Boolean).join(' ')}>
      <span className={`node-kind kind-${view.toneFor?.(node as never) ?? view.tone}`} aria-hidden="true">
        <Icon size={14} strokeWidth={1.75} />
      </span>
      <span className="rf-node-title" title={title}>
        {title}
      </span>
      {pinned === true && (
        <span className="node-pin-badge" role="img" aria-label="Pinned result" title="Pinned result">
          <Pin size={12} strokeWidth={1.75} aria-hidden="true" />
        </span>
      )}
      {problems !== undefined && <ProblemBadge problems={problems} />}
      {pillOrButton}
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
  const { graphNode, status, problems } = data;
  const view = viewFor(graphNode.kind);
  const chip = view.chip?.(graphNode as never);
  const rows = view.rows(graphNode as never);
  const chips = [...(chip !== undefined ? [chip] : []), ...(extraChips ?? [])];
  // A proposal-edited node carries an "edited" marker chip (C21).
  const edited = graphNode.proposed === 'edit';
  // R09: a turned-off agent's non-chat trigger nodes dim with the contract tooltip.
  const triggerOff = data.agentEnabled === false && graphNode.kind === 'trigger' && graphNode.data.item.type !== 'chat';

  return (
    <div
      className={`${cardClassName('rf-node', selected, data)}${triggerOff ? ' node-trigger-off' : ''}`}
      data-node-kind={graphNode.kind}
      data-node-id={graphNode.id}
      title={triggerOff ? 'Off — triggers won\'t fire' : undefined}
    >
      {view.ports.in && <Handle type="target" position={Position.Left} className="rf-port rf-port-in" />}
      {view.ports.out && <Handle type="source" position={Position.Right} className="rf-port rf-port-out" />}
      <NodeCardHead
        node={graphNode}
        status={status}
        problems={problems}
        graph={data.graph}
        onViewSpans={data.onViewSpans}
        pinned={data.pinned}
      >
        {headAction}
      </NodeCardHead>
      {(chips.length > 0 || edited) && (
        <div className="rf-node-meta">
          {chips.map((c) => (
            <code className="node-chip" title={c} key={c}>
              {c}
            </code>
          ))}
          {edited && (
            <code className="node-chip node-chip-edited" title="Changed by the proposal">
              edited
            </code>
          )}
        </div>
      )}
      <NodeRows rows={rows} />
    </div>
  );
}
