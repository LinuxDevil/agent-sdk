import { memo, useState } from 'react';
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
};

function rowsFor(node: AgentGraphNode): { k: string; v: string }[] {
  switch (node.type) {
    case 'trigger':
      return [{ k: 'type', v: node.data.trigger.type || '(unset)' }];
    case 'llm':
      return [
        { k: 'provider', v: node.data.provider.type || '(unset)' },
        { k: 'model', v: node.data.provider.model || '(unset)' },
      ];
    case 'tool':
      return [{ k: 'tool', v: node.data.toolName || '(unset)' }];
    case 'approval':
      return [{ k: 'requiresApproval', v: node.data.policy.requiresApproval ? 'yes' : 'no' }];
    case 'output':
      return [];
  }
}

export interface AgentNodeData extends Record<string, unknown> {
  graphNode: AgentGraphNode;
  onRename: (nodeId: string, label: string) => void;
  /** O2: true when this node's log/span is the one currently selected in the drawer. */
  highlighted?: boolean;
  /** O3: true when this node has an active breakpoint set. */
  hasBreakpoint?: boolean;
}

function AgentNodeImpl({ data, selected }: NodeProps) {
  const { graphNode, onRename, highlighted, hasBreakpoint } = data as unknown as AgentNodeData;
  const meta = NODE_META[graphNode.type];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(graphNode.label);

  function commitRename() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== graphNode.label) onRename(graphNode.id, trimmed);
    else setDraft(graphNode.label);
  }

  return (
    <div
      className={`rf-node${selected ? ' selected' : ''}${highlighted ? ' highlighted' : ''}${hasBreakpoint ? ' has-breakpoint' : ''}`}
      data-node-type={graphNode.type}
    >
      {meta.hasIn && <Handle type="target" position={Position.Left} className="rf-port rf-port-in" />}
      {meta.hasOut && <Handle type="source" position={Position.Right} className="rf-port rf-port-out" />}
      <div className="rf-node-head" style={{ borderBottom: '1px solid var(--border)' }}>
        <span className="node-swatch" style={{ background: meta.color, width: 16, height: 16, borderRadius: 5 }}>
          {meta.icon}
        </span>
        {editing ? (
          <input
            className="input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                setDraft(graphNode.label);
                setEditing(false);
              }
            }}
            style={{ padding: '2px 6px', fontSize: 12 }}
          />
        ) : (
          <span
            className="rf-node-title"
            onDoubleClick={() => {
              setDraft(graphNode.label);
              setEditing(true);
            }}
            title="Double-click to rename"
          >
            {graphNode.label}
          </span>
        )}
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

export const AgentNode = memo(AgentNodeImpl);

export const NODE_TYPES = {
  trigger: AgentNode,
  llm: AgentNode,
  tool: AgentNode,
  approval: AgentNode,
  output: AgentNode,
};
