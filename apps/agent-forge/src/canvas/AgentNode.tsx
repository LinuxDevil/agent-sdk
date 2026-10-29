import { memo, useState, type KeyboardEvent } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Wrench } from 'lucide-react';
import type { AgentGraphNode, AgentGraphNodeType } from '../graph/types';
import { StatusPill } from '../ui/StatusPill';
import { NODE_KINDS } from './nodeKinds';

/**
 * Custom ReactFlow node renderer for every `AgentGraphNodeType`: a 240px card
 * whose header carries a kind icon tile, the node's name and its run status
 * pill; a meta row (an LLM node's `provider/model` chip and tool count); a
 * body of key/value config rows read straight from the node's
 * `AgentGraphSpec` data (nothing hardcoded per-node); and left/right ports
 * drawn with ReactFlow's own `<Handle>` so pipeline connections attach to a
 * real, draggable anchor rather than a picture of one.
 *
 * One component + a `type` field handles all six kinds rather than six
 * near-duplicate components, since the only real differences are the
 * kind tile's tone/icon, which ports are shown, and which data rows to render.
 */

/** Which ports each kind has. Its tone and icon come from nodeKinds.ts's NODE_KINDS. */
const NODE_PORTS: Record<AgentGraphNodeType, { hasIn: boolean; hasOut: boolean }> = {
  trigger: { hasIn: false, hasOut: true },
  llm: { hasIn: true, hasOut: true },
  tool: { hasIn: true, hasOut: true },
  approval: { hasIn: true, hasOut: true },
  output: { hasIn: true, hasOut: false },
  // Router: `hasOut: true` matters here more than anywhere else - it's the
  // one node type actually expected to carry MULTIPLE outgoing edges (its
  // branches), which ReactFlow already supports from a single source
  // `Handle` (see llm -> multiple tool nodes, an existing pattern this
  // reuses rather than needing per-branch ports).
  router: { hasIn: true, hasOut: true },
};

type NodeRow = { k: string; v: string };
type RowBuilder<T extends AgentGraphNodeType> = (node: Extract<AgentGraphNode, { type: T }>) => NodeRow[];

function orUnset(value: string | undefined): string {
  return value || '(unset)';
}

const ROW_BUILDERS: { [T in AgentGraphNodeType]: RowBuilder<T> } = {
  trigger: (node) => [{ k: 'type', v: orUnset(node.data.trigger.type) }],
  // The provider/model is the card's model chip instead.
  llm: () => [],
  tool: (node) => [{ k: 'tool', v: orUnset(node.data.toolName) }],
  approval: (node) => [{ k: 'requiresApproval', v: node.data.policy.requiresApproval ? 'yes' : 'no' }],
  output: () => [],
  router: () => [],
};

function rowsFor(node: AgentGraphNode): NodeRow[] {
  const build = ROW_BUILDERS[node.type] as (n: AgentGraphNode) => NodeRow[];
  return build(node);
}

export interface AgentNodeData extends Record<string, unknown> {
  graphNode: AgentGraphNode;
  onRename: (nodeId: string, label: string) => void;
  /** True when this node's log/span is the one currently selected in the drawer. */
  highlighted?: boolean;
  /** True when this node has an active breakpoint set. */
  hasBreakpoint?: boolean;
  /** Tools the agent can call, shown on its LLM node (omitted or 0: no count). */
  toolCount?: number;
  /** This node's status in the current run (see nodeStatus.ts); omitted reads idle. */
  status?: string;
}

/**
 * Rename-in-place state: `draft` is the in-progress label, `commit` applies
 * it (or reverts when empty/unchanged), `cancel` reverts, `start` enters
 * edit mode from the node's current label.
 */
function useRenameDraft(graphNode: AgentGraphNode, onRename: (nodeId: string, label: string) => void) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(graphNode.label);

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== graphNode.label) onRename(graphNode.id, trimmed);
    else setDraft(graphNode.label);
  }

  function cancel() {
    setDraft(graphNode.label);
    setEditing(false);
  }

  function start() {
    setDraft(graphNode.label);
    setEditing(true);
  }

  return { editing, draft, setDraft, commit, cancel, start };
}

type RenameDraft = ReturnType<typeof useRenameDraft>;

function nodeClassName(selected: boolean | undefined, data: Pick<AgentNodeData, 'highlighted' | 'hasBreakpoint' | 'status'>): string {
  const flags: [string, boolean | undefined][] = [
    ['selected', selected],
    ['highlighted', data.highlighted],
    ['has-breakpoint', data.hasBreakpoint],
    ['running', data.status === 'running'],
  ];
  return ['rf-node', ...flags.filter(([, on]) => on).map(([name]) => name)].join(' ');
}

// Pre·N / post·N badges (`.hook-badge`) - only
// ENABLED hooks count, since a disabled hook has no runtime effect (see
// graphToSpec.ts's serialization, which drops disabled hooks entirely).
function HookBadge({ phase, count }: { phase: 'pre' | 'post'; count: number }) {
  if (count === 0) return null;
  return (
    <span className={`hook-badge ${phase}`}>
      {phase}&middot;{count}
    </span>
  );
}

function HookBadges({ graphNode }: { graphNode: AgentGraphNode }) {
  const enabledHooks = (graphNode.hooks ?? []).filter((h) => h.enabled);
  const preCount = enabledHooks.filter((h) => h.phase === 'pre').length;
  const postCount = enabledHooks.filter((h) => h.phase === 'post').length;
  if (preCount + postCount === 0) return null;
  return (
    <span className="node-hooks">
      <HookBadge phase="pre" count={preCount} />
      <HookBadge phase="post" count={postCount} />
    </span>
  );
}

function renameKeyHandler(rename: RenameDraft) {
  return (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') rename.commit();
    if (e.key === 'Escape') rename.cancel();
  };
}

function NodeTitle({ label, rename }: { label: string; rename: RenameDraft }) {
  if (rename.editing) {
    return (
      <input
        className="input"
        autoFocus
        value={rename.draft}
        onChange={(e) => rename.setDraft(e.target.value)}
        onBlur={rename.commit}
        onKeyDown={renameKeyHandler(rename)}
        style={{ padding: '2px 6px', fontSize: 12 }}
      />
    );
  }
  return (
    <span className="rf-node-title" onDoubleClick={rename.start} title={`${label} (double-click to rename)`}>
      {label}
    </span>
  );
}

/** `provider/model` for an LLM node, else nothing. */
function modelChipOf(graphNode: AgentGraphNode): string | undefined {
  if (graphNode.type !== 'llm') return undefined;
  return `${orUnset(graphNode.data.provider.type)}/${orUnset(graphNode.data.provider.model)}`;
}

/** The model chip and tool count; nothing at all for a node with neither. */
function NodeMeta({ graphNode, toolCount = 0 }: Pick<AgentNodeData, 'graphNode' | 'toolCount'>) {
  const model = modelChipOf(graphNode);
  if (!model && toolCount === 0) return null;
  return (
    <div className="rf-node-meta">
      {model && (
        <code className="node-chip node-model" title={`Provider/model: ${model}`}>
          {model}
        </code>
      )}
      {toolCount > 0 && (
        <span className="node-chip node-tools">
          <Wrench size={12} strokeWidth={1.75} aria-hidden="true" />
          {toolCount === 1 ? '1 tool' : `${toolCount} tools`}
        </span>
      )}
    </div>
  );
}

function NodeRows({ rows }: { rows: NodeRow[] }) {
  // No empty body box under a node with nothing to show (llm, output, router).
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
  const { graphNode, onRename, toolCount, status } = nodeData;
  const { tone, Icon } = NODE_KINDS[graphNode.type];
  const { hasIn, hasOut } = NODE_PORTS[graphNode.type];
  const rename = useRenameDraft(graphNode, onRename);

  return (
    <div className={nodeClassName(selected, nodeData)} data-node-type={graphNode.type} data-node-id={graphNode.id}>
      {hasIn && <Handle type="target" position={Position.Left} className="rf-port rf-port-in" />}
      {hasOut && <Handle type="source" position={Position.Right} className="rf-port rf-port-out" />}
      <HookBadges graphNode={graphNode} />
      <div className="rf-node-head">
        <span className={`node-kind kind-${tone}`} aria-hidden="true">
          <Icon size={14} strokeWidth={1.75} />
        </span>
        <NodeTitle label={graphNode.label} rename={rename} />
        <StatusPill status={status ?? 'idle'} />
      </div>
      <NodeMeta graphNode={graphNode} toolCount={toolCount} />
      <NodeRows rows={rowsFor(graphNode)} />
    </div>
  );
}

const AgentNode = memo(AgentNodeImpl);

/**
 * The React Flow node type for a graph node. Prefixed so none
 * collides with React Flow's built-in `input`/`output`/`default`/`group`
 * types - a node typed `output` picked up `.react-flow__node-output`'s
 * default border, padding and width and was drawn double-boxed. The graph's
 * own `type` (what is saved) is unchanged.
 */
export function flowNodeType(type: AgentGraphNodeType): string {
  return `agent-${type}`;
}

const GRAPH_NODE_TYPES: AgentGraphNodeType[] = ['trigger', 'llm', 'tool', 'approval', 'output', 'router'];

export const NODE_TYPES: Record<string, typeof AgentNode> = Object.fromEntries(
  GRAPH_NODE_TYPES.map((type) => [flowNodeType(type), AgentNode])
);

/** The MiniMap draws each node in its kind's tile colour (see `.minimap-node-*` in screens/agents/agents.css). */
export function miniMapNodeClassName(node: { data: Record<string, unknown> }): string {
  const graphNode = (node.data as Partial<AgentNodeData>).graphNode;
  return graphNode ? `minimap-node-${graphNode.type}` : '';
}
