import { useState } from 'react';
import type { DragEvent } from 'react';
import { useAppState } from '../state/AppState';
import { PALETTE_DRAG_MIME, HOOK_DRAG_MIME } from '../canvas/dnd';
import { AGENT_TEMPLATES, type TemplateId } from '../canvas/templates';
import type { AgentGraphNodeType, AgentNodeHookPhase } from '../graph/types';

const NODE_PALETTE: { section: string; items: { label: string; color: string; nodeType: AgentGraphNodeType }[] }[] = [
  {
    section: 'Trigger',
    items: [{ label: 'Input trigger', color: 'var(--info)', nodeType: 'trigger' }],
  },
  {
    section: 'Reasoning',
    items: [{ label: 'LLM step', color: 'var(--accent)', nodeType: 'llm' }],
  },
  {
    section: 'Tools',
    items: [
      { label: 'Tool call', color: 'var(--warning)', nodeType: 'tool' },
      { label: 'Approval gate', color: 'var(--warning)', nodeType: 'approval' },
    ],
  },
  {
    section: 'Output',
    items: [{ label: 'Response / output', color: 'var(--success)', nodeType: 'output' }],
  },
];

/**
 * Hooks (pre/post) palette entries (LOU-Q3). Unlike NODE_PALETTE's items,
 * dropping one of these does NOT add a new `AgentGraphNode` - it attaches
 * an `AgentNodeHookInstance` onto whichever node the drop lands on (see
 * dnd.ts's HOOK_DRAG_MIME and CanvasArea.tsx's onDrop), so this list is
 * kept separate rather than folded into NODE_PALETTE.
 */
const HOOK_PALETTE: { label: string; color: string; phase: AgentNodeHookPhase }[] = [
  { label: 'Pre-hook', color: 'var(--info)', phase: 'pre' },
  { label: 'Post-hook', color: 'var(--accent)', phase: 'post' },
];

const STATUS_LABEL: Record<string, string> = {
  idle: 'idle',
  running: 'running',
  stopped: 'stopped',
  error: 'error',
  paused: 'awaiting approval',
};

export function LeftRail() {
  const { railTab, setRailTab, agents, agentId, graph, spec, switchAgent, createAgent, agentStatuses } =
    useAppState();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTemplate, setNewTemplate] = useState<TemplateId>('blank');

  function onDragStart(e: DragEvent<HTMLDivElement>, nodeType: AgentGraphNodeType) {
    e.dataTransfer.setData(PALETTE_DRAG_MIME, nodeType);
    e.dataTransfer.effectAllowed = 'move';
  }

  function onHookDragStart(e: DragEvent<HTMLDivElement>, phase: AgentNodeHookPhase) {
    e.dataTransfer.setData(HOOK_DRAG_MIME, phase);
    e.dataTransfer.effectAllowed = 'move';
  }

  async function handleCreate() {
    const id = newName.trim();
    if (!id) return;
    await createAgent(id, newTemplate);
    setCreating(false);
    setNewName('');
    setNewTemplate('blank');
  }

  return (
    <div className="rail">
      <div className="rail-tabs">
        <button
          className={`rail-tab${railTab === 'agents' ? ' active' : ''}`}
          onClick={() => setRailTab('agents')}
        >
          Agents
        </button>
        <button className={`rail-tab${railTab === 'nodes' ? ' active' : ''}`} onClick={() => setRailTab('nodes')}>
          Nodes
        </button>
      </div>

      {railTab === 'agents' ? (
        <div className="rail-body">
          <div className="rail-section-title">Workspace</div>
          {agents.length === 0 && (
            <div className="agent-card selected">
              <div className="agent-card-top">
                <span className="agent-name">{spec.name}</span>
                <span className="status-pill status-running">
                  <span className="dot" style={{ background: 'var(--success)' }} />
                  unsaved
                </span>
              </div>
              <div className="agent-meta">
                {spec.provider.model} &middot; {graph.nodes.length} nodes
              </div>
            </div>
          )}
          {agents.map((entry) => {
            // LOU-N: real run status pushed over WS (see AppState's
            // agentStatuses), replacing LOU-L/M's "active"/"idle"
            // placeholder derived only from which agent is loaded in the
            // canvas. An agent can be 'running' in the background even
            // while a different agent is selected in the canvas.
            const status = agentStatuses[entry.id]?.status ?? 'idle';
            return (
              <div
                className={`agent-card${entry.id === agentId ? ' selected' : ''}`}
                key={entry.id}
                role="button"
                tabIndex={0}
                onClick={() => void switchAgent(entry.id)}
                onKeyDown={(e) => e.key === 'Enter' && void switchAgent(entry.id)}
              >
                <div className="agent-card-top">
                  <span className="agent-name">{entry.id}</span>
                  <span className={`status-pill status-${status}`}>
                    <span className="dot" />
                    {STATUS_LABEL[status] ?? status}
                  </span>
                </div>
                <div className="agent-meta">
                  {entry.spec.provider.model} &middot; {entry.spec.tools?.length ?? 0} tools
                </div>
              </div>
            );
          })}

          {creating ? (
            <div className="agent-card" style={{ cursor: 'default' }}>
              <div className="field" style={{ marginBottom: 8 }}>
                <label htmlFor="new-agent-name">Name</label>
                <input
                  id="new-agent-name"
                  className="input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="my-new-agent"
                  autoFocus
                />
              </div>
              <div className="field" style={{ marginBottom: 8 }}>
                <label htmlFor="new-agent-template">Template</label>
                <select
                  id="new-agent-template"
                  className="select"
                  value={newTemplate}
                  onChange={(e) => setNewTemplate(e.target.value as TemplateId)}
                >
                  {AGENT_TEMPLATES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <div className="hint">{AGENT_TEMPLATES.find((t) => t.id === newTemplate)?.description}</div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => void handleCreate()} disabled={!newName.trim()}>
                  Create
                </button>
                <button className="btn" onClick={() => setCreating(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              className="btn"
              style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
              onClick={() => setCreating(true)}
            >
              + New agent
            </button>
          )}
        </div>
      ) : (
        <div className="rail-body">
          {NODE_PALETTE.map((group) => (
            <div key={group.section}>
              <div className="rail-section-title">{group.section}</div>
              {group.items.map((item) => (
                <div
                  className="node-palette-item"
                  draggable
                  onDragStart={(e) => onDragStart(e, item.nodeType)}
                  key={item.label}
                  title="Drag onto the canvas to add"
                >
                  <span className="node-swatch" style={{ background: item.color }} />
                  {item.label}
                </div>
              ))}
            </div>
          ))}
          <div>
            <div className="rail-section-title">Hooks</div>
            {HOOK_PALETTE.map((item) => (
              <div
                className="node-palette-item"
                draggable
                onDragStart={(e) => onHookDragStart(e, item.phase)}
                key={item.label}
                title="Drag onto a node to attach a hook"
              >
                <span className="node-swatch" style={{ background: item.color }} />
                {item.label}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
