import { useAppState } from '../state/AppState';

/**
 * Static sample data for the "other agents in the workspace" list. This
 * epic (LOU-L) has no runtime/multi-agent workspace yet (that's LOU-N) - the
 * only agent with real state is the one in AppState, backed by the
 * AgentStore. These are chrome/visual placeholders only.
 */
const SAMPLE_AGENTS = [
  { name: 'doc-qa', status: 'stopped', meta: 'claude-3.7-sonnet · 6 nodes' },
  { name: 'ops-pipeline', status: 'error', meta: 'gpt-4o · 8 nodes' },
  { name: 'research-assistant', status: 'paused', meta: 'awaiting approval' },
] as const;

const NODE_PALETTE: { section: string; items: { label: string; color: string }[] }[] = [
  {
    section: 'Trigger',
    items: [
      { label: 'Input trigger', color: 'var(--info)' },
      { label: 'Scheduled trigger', color: 'var(--info)' },
    ],
  },
  {
    section: 'Reasoning',
    items: [
      { label: 'LLM step', color: 'var(--accent)' },
      { label: 'Router / condition', color: 'var(--accent)' },
    ],
  },
  {
    section: 'Tools',
    items: [
      { label: 'Tool call', color: 'var(--warning)' },
      { label: 'Approval gate', color: 'var(--warning)' },
    ],
  },
  {
    section: 'Output',
    items: [{ label: 'Response / output', color: 'var(--success)' }],
  },
  {
    section: 'Hooks',
    items: [
      { label: 'Pre-hook', color: 'var(--info)' },
      { label: 'Post-hook', color: 'var(--accent)' },
    ],
  },
];

export function LeftRail() {
  const { railTab, setRailTab, spec } = useAppState();

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
          <div className="agent-card selected">
            <div className="agent-card-top">
              <span className="agent-name">{spec.name}</span>
              <span className="status-pill status-running">
                <span className="dot" style={{ background: 'var(--success)' }} />
                running
              </span>
            </div>
            <div className="agent-meta">
              {spec.provider.model} &middot; {spec.tools?.length ?? 0} tools
            </div>
          </div>
          {SAMPLE_AGENTS.map((agent) => (
            <div className="agent-card" key={agent.name}>
              <div className="agent-card-top">
                <span className="agent-name">{agent.name}</span>
                <span className={`status-pill status-${agent.status}`}>
                  <span className="dot" style={{ background: 'var(--text-faint)' }} />
                  {agent.status}
                </span>
              </div>
              <div className="agent-meta">{agent.meta}</div>
            </div>
          ))}
          <button className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} disabled>
            + New agent
          </button>
        </div>
      ) : (
        <div className="rail-body">
          {NODE_PALETTE.map((group) => (
            <div key={group.section}>
              <div className="rail-section-title">{group.section}</div>
              {group.items.map((item) => (
                <div className="node-palette-item" draggable key={item.label}>
                  <span className="node-swatch" style={{ background: item.color }} />
                  {item.label}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
