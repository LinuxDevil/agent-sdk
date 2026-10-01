import { memo, useState, type KeyboardEvent } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { AgentGraphNode, AgentGraphNodeType } from '../graph/types';

/**
 * Custom ReactFlow node renderer for every `AgentGraphNodeType`, styled to
 * match `.design-ref/agent-forge-mockup.html`'s `.node` chrome: a colored
 * type-swatch header, a body of key/value config rows read straight from
 * the node's `AgentGraphSpec` data (nothing hardcoded per-node), and
 * left/right ports drawn with ReactFlow's own `<Handle>` so pipeline
 * connections attach to a real, draggable anchor rather than a picture of
 * one.
 *
 * One component + a `type` field handles all five kinds rather than five
 * near-duplicate components, since the only real differences are the
 * swatch color/icon, which ports are shown, and which data rows to render.
 */

const NODE_META: Record<AgentGraphNodeType, { color: string; icon: string; hasIn: boolean; hasOut: boolean }> = {
  trigger: { color: 'var(--info)', icon: '⚡', hasIn: false, hasOut: true },
  llm: { color: 'var(--accent)', icon: '🧠', hasIn: true, hasOut: true },
  tool: { color: 'var(--warning)', icon: '🔧', hasIn: true, hasOut: true },
  approval: { color: 'var(--warning)', icon: '✓', hasIn: true, hasOut: true },
  output: { color: 'var(--success)', icon: '→', hasIn: true, hasOut: false },
  // LOU-T3: router shares tool's warning-orange swatch family (both are
  // "control" nodes in the mockup's visual language, see
  // .design-ref/agent-forge-mockup.html) but with its own icon so it reads
  // distinctly on the canvas; `hasOut: true` matters here more than
  // anywhere else - it's the one node type actually expected to carry
  // MULTIPLE outgoing edges (its branches), which ReactFlow already
  // supports from a single source `Handle` (see llm -> multiple tool nodes,
  // an existing pattern this reuses rather than needing per-branch ports).
  router: { color: 'var(--danger)', icon: '⑂', hasIn: true, hasOut: true },
};

type NodeRow = { k: string; v: string };
type RowBuilder<T extends AgentGraphNodeType> = (node: Extract<AgentGraphNode, { type: T }>) => NodeRow[];

function orUnset(value: string | undefined): string {
  return value || '(unset)';
}

const ROW_BUILDERS: { [T in AgentGraphNodeType]: RowBuilder<T> } = {
  trigger: (node) => [{ k: 'type', v: orUnset(node.data.trigger.type) }],
  llm: (node) => [
    { k: 'provider', v: orUnset(node.data.provider.type) },
    { k: 'model', v: orUnset(node.data.provider.model) },
  ],
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
  /** O2: true when this node's log/span is the one currently selected in the drawer. */
  highlighted?: boolean;
  /** O3: true when this node has an active breakpoint set. */
  hasBreakpoint?: boolean;
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

function nodeClassName(selected: boolean | undefined, highlighted?: boolean, hasBreakpoint?: boolean): string {
  return `rf-node${selected ? ' selected' : ''}${highlighted ? ' highlighted' : ''}${hasBreakpoint ? ' has-breakpoint' : ''}`;
}

// LOU-Q3: pre·N / post·N badges, matching the mockup's `.hook-badge`
// (search `.design-ref/agent-forge-mockup.html` for `hook-badge`) - only
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
    <span className="rf-node-title" onDoubleClick={rename.start} title="Double-click to rename">
      {label}
    </span>
  );
}

function AgentNodeImpl({ data, selected }: NodeProps) {
  const { graphNode, onRename, highlighted, hasBreakpoint } = data as unknown as AgentNodeData;
  const meta = NODE_META[graphNode.type];
  const rename = useRenameDraft(graphNode, onRename);

  return (
    <div
      className={nodeClassName(selected, highlighted, hasBreakpoint)}
      data-node-type={graphNode.type}
      data-node-id={graphNode.id}
    >
      {meta.hasIn && <Handle type="target" position={Position.Left} className="rf-port rf-port-in" />}
      {meta.hasOut && <Handle type="source" position={Position.Right} className="rf-port rf-port-out" />}
      <HookBadges graphNode={graphNode} />
      <div className="rf-node-head" style={{ borderBottom: '1px solid var(--border)' }}>
        <span className="node-swatch" style={{ background: meta.color, width: 16, height: 16, borderRadius: 5 }}>
          {meta.icon}
        </span>
        <NodeTitle label={graphNode.label} rename={rename} />
      </div>
      <div className="rf-node-body">
        {rowsFor(graphNode).map((row) => (
          <div className="node-row" key={row.k}>
            <span>{row.k}</span>
            <code>{row.v}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

const AgentNode = memo(AgentNodeImpl);

export const NODE_TYPES = {
  trigger: AgentNode,
  llm: AgentNode,
  tool: AgentNode,
  approval: AgentNode,
  output: AgentNode,
  router: AgentNode,
};
