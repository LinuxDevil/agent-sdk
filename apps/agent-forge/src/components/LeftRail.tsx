import { useState } from 'react';
import type { DragEvent } from 'react';
import { useStoreApi } from '@xyflow/react';
import { useAppState } from '../state/AppState';
import { PALETTE_DRAG_MIME, HOOK_DRAG_MIME } from '../canvas/dnd';
import { AGENT_TEMPLATES, type TemplateId } from '../canvas/templates';
import { addHookToNode, addNode } from '../canvas/graphMutations';
import { pickHookTemplate, viewportCentrePosition } from '../canvas/paletteActions';
import { StatusPill } from './StatusPill';
import { errorMessage } from './errorMessage';
import { tabIds, tabListKeyDown } from './tabs';
import { agentIdProblem } from '../../shared/agentId';
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
  // LOU-T3: router/condition node - drag onto the canvas, then wire 2+
  // outgoing edges from it (each becomes a branch, edited in the Inspector)
  // to make the graph actually branch instead of following one fixed path.
  {
    section: 'Routing',
    items: [{ label: 'Router / condition', color: 'var(--danger)', nodeType: 'router' }],
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

function UnsavedAgentCard() {
  const { graph, spec } = useAppState();
  return (
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
  );
}

type AgentEntry = ReturnType<typeof useAppState>['agents'][number];
type AgentStatuses = ReturnType<typeof useAppState>['agentStatuses'];

function agentStatusOf(agentStatuses: AgentStatuses, id: string): string {
  return agentStatuses[id]?.status ?? 'idle';
}

function toolCountOf(entry: AgentEntry): number {
  return entry.spec.tools?.length ?? 0;
}

function AgentCard({ entry }: { entry: AgentEntry }) {
  const { agentId, switchAgent, agentStatuses } = useAppState();
  // LOU-N: real run status pushed over WS (see AppState's
  // agentStatuses), replacing LOU-L/M's "active"/"idle"
  // placeholder derived only from which agent is loaded in the
  // canvas. An agent can be 'running' in the background even
  // while a different agent is selected in the canvas.
  const status = agentStatusOf(agentStatuses, entry.id);
  return (
    <div
      className={`agent-card${entry.id === agentId ? ' selected' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => void switchAgent(entry.id)}
      onKeyDown={(e) => e.key === 'Enter' && void switchAgent(entry.id)}
    >
      <div className="agent-card-top">
        <span className="agent-name">{entry.id}</span>
        <StatusPill status={status} />
      </div>
      <div className="agent-meta">
        {entry.spec.provider.model} &middot; {toolCountOf(entry)} tools
      </div>
    </div>
  );
}

/** The "+ New agent" form's open state and field values; kept in LeftRail so they survive switching rail tabs. */
function useNewAgentDraft() {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTemplate, setNewTemplate] = useState<TemplateId>('blank');
  return { creating, setCreating, newName, setNewName, newTemplate, setNewTemplate };
}

type NewAgentDraft = ReturnType<typeof useNewAgentDraft>;

function NewAgentForm({ draft }: { draft: NewAgentDraft }) {
  const { createAgent } = useAppState();
  const { setCreating, newName, setNewName, newTemplate, setNewTemplate } = draft;
  const [createError, setCreateError] = useState<string | undefined>(undefined);
  const trimmed = newName.trim();
  // Eve DUI-F3: the same rule the server enforces on `:id` (shared/agentId.ts) -
  // an invalid name used to be saved locally, then crash the app on the
  // server's 400.
  const nameProblem = trimmed ? agentIdProblem(trimmed) : undefined;

  async function handleCreate() {
    if (!trimmed || nameProblem) return;
    setCreateError(undefined);
    try {
      await createAgent(trimmed, newTemplate);
    } catch (error) {
      setCreateError(errorMessage(error));
      return;
    }
    setCreating(false);
    setNewName('');
    setNewTemplate('blank');
  }

  return (
    <div className="agent-card" style={{ cursor: 'default' }}>
      <div className="field" style={{ marginBottom: 8 }}>
        <label htmlFor="new-agent-name">Name</label>
        <input
          id="new-agent-name"
          className="input"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
          placeholder="my-new-agent"
          aria-invalid={nameProblem ? true : undefined}
          aria-describedby={nameProblem || createError ? 'new-agent-name-error' : undefined}
          autoFocus
        />
        {(nameProblem || createError) && (
          <div id="new-agent-name-error" className="hint field-error" role="alert">
            {nameProblem ?? createError}
          </div>
        )}
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
        <button
          className="btn btn-primary"
          style={{ flex: 1, justifyContent: 'center' }}
          onClick={() => void handleCreate()}
          disabled={!trimmed || nameProblem !== undefined}
        >
          Create
        </button>
        <button className="btn" onClick={() => setCreating(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function AgentsTab({ draft }: { draft: NewAgentDraft }) {
  const { agents } = useAppState();

  return (
    <div className="rail-body">
      <div className="rail-section-title">Workspace</div>
      {agents.length === 0 && <UnsavedAgentCard />}
      {agents.map((entry) => (
        <AgentCard key={entry.id} entry={entry} />
      ))}

      {draft.creating ? (
        <NewAgentForm draft={draft} />
      ) : (
        <button
          className="btn"
          style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
          onClick={() => draft.setCreating(true)}
        >
          + New agent
        </button>
      )}
    </div>
  );
}

/**
 * Eve DUI-F9: a palette entry is a real button - drag it onto the canvas as
 * before, or activate it (click, Enter, Space) to add it without a mouse.
 */
function PaletteItem({
  label,
  color,
  title,
  onDragStart,
  onActivate,
}: {
  label: string;
  color: string;
  title: string;
  onDragStart: (e: DragEvent<HTMLButtonElement>) => void;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      className="node-palette-item"
      draggable
      onDragStart={onDragStart}
      onClick={onActivate}
      title={title}
    >
      <span className="node-swatch" style={{ background: color }} aria-hidden="true" />
      {label}
    </button>
  );
}

function startPaletteDrag(e: DragEvent<HTMLButtonElement>, mime: string, payload: string) {
  e.dataTransfer.setData(mime, payload);
  e.dataTransfer.effectAllowed = 'move';
}

/** Click/keyboard equivalents of the palette's drag-and-drop (Eve DUI-F9). */
function usePaletteActions() {
  const { graph, setGraph, selectedNodeId, setSelectedNodeId } = useAppState();
  const flow = useStoreApi();
  const [notice, setNotice] = useState<string | undefined>(undefined);

  function addAtViewportCentre(nodeType: AgentGraphNodeType, label: string) {
    const { transform, width, height } = flow.getState();
    const position = viewportCentrePosition(transform, width, height);
    const next = addNode(graph, nodeType, position);
    const added = next.nodes[next.nodes.length - 1];
    setGraph(() => next);
    setSelectedNodeId(added.id);
    setNotice(`Added ${label} to the canvas.`);
  }

  function attachHook(phase: AgentNodeHookPhase, label: string) {
    const target = graph.nodes.find((n) => n.id === selectedNodeId);
    if (!target || (target.type !== 'llm' && target.type !== 'tool')) {
      setNotice(`Select an LLM or tool node first, then add the ${label}.`);
      return;
    }
    setGraph((g) => addHookToNode(g, target.id, pickHookTemplate(target.type as 'llm' | 'tool', phase)));
    setNotice(`Attached a ${label} to ${target.label}.`);
  }

  return { notice, addAtViewportCentre, attachHook };
}

function NodesTab() {
  const { notice, addAtViewportCentre, attachHook } = usePaletteActions();
  return (
    <div className="rail-body">
      {NODE_PALETTE.map((group) => (
        <div key={group.section}>
          <div className="rail-section-title">{group.section}</div>
          {group.items.map((item) => (
            <PaletteItem
              key={item.label}
              label={item.label}
              color={item.color}
              title="Drag onto the canvas, or press to add at the centre"
              onDragStart={(e) => startPaletteDrag(e, PALETTE_DRAG_MIME, item.nodeType)}
              onActivate={() => addAtViewportCentre(item.nodeType, item.label)}
            />
          ))}
        </div>
      ))}
      <div>
        <div className="rail-section-title">Hooks</div>
        {HOOK_PALETTE.map((item) => (
          <PaletteItem
            key={item.label}
            label={item.label}
            color={item.color}
            title="Drag onto a node, or press to attach to the selected LLM/tool node"
            onDragStart={(e) => startPaletteDrag(e, HOOK_DRAG_MIME, item.phase)}
            onActivate={() => attachHook(item.phase, item.label.toLowerCase())}
          />
        ))}
      </div>
      <div className="hint palette-notice" role="status">
        {notice}
      </div>
    </div>
  );
}

const RAIL_TABS = [
  { id: 'agents', label: 'Agents' },
  { id: 'nodes', label: 'Nodes' },
] as const;
type RailTabId = (typeof RAIL_TABS)[number]['id'];
const RAIL_TAB_IDS: RailTabId[] = RAIL_TABS.map((t) => t.id);

export function LeftRail() {
  const { railTab, setRailTab } = useAppState();
  const draft = useNewAgentDraft();
  const ids = tabIds('rail', railTab);

  // Eve DUI-F9: a `nav` landmark with a real WAI-ARIA tablist.
  return (
    <nav className="rail" aria-label="Agents and node palette">
      <div
        className="rail-tabs"
        role="tablist"
        aria-label="Rail"
        onKeyDown={tabListKeyDown('rail', RAIL_TAB_IDS, railTab, setRailTab)}
      >
        {RAIL_TABS.map((tab) => {
          const selected = railTab === tab.id;
          const { tab: tabId, panel } = tabIds('rail', tab.id);
          return (
            <button
              key={tab.id}
              id={tabId}
              role="tab"
              aria-selected={selected}
              aria-controls={panel}
              tabIndex={selected ? 0 : -1}
              className={`rail-tab${selected ? ' active' : ''}`}
              onClick={() => setRailTab(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="rail-panel" id={ids.panel} role="tabpanel" aria-labelledby={ids.tab}>
        {railTab === 'agents' ? <AgentsTab draft={draft} /> : <NodesTab />}
      </div>
    </nav>
  );
}
