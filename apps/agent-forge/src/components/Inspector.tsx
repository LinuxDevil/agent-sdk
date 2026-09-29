import { useAppState } from '../state/AppState';
import { updateNodeData, renameNode } from '../canvas/graphMutations';

const KNOWN_PROVIDERS = ['mock', 'openai', 'anthropic', 'ollama', 'openrouter'];

/**
 * Inspector (LOU-M): reflects and edits whichever canvas node is currently
 * selected, wired through `AppState.graph`/`selectedNodeId` - the same
 * mechanism the canvas itself reads/writes (see CanvasArea.tsx), so there
 * is exactly one source of truth for node data, per the epic's
 * "no second state system" constraint. Field sets are still limited to
 * what `AgentGraphNode['data']` actually carries per node type (see
 * graph/types.ts); richer per-node config (temperature, max-steps, hook
 * wiring) needs `AgentSpec` itself to grow those fields first.
 */
export function Inspector() {
  const { graph, setGraph, selectedNodeId } = useAppState();
  const selected = graph.nodes.find((n) => n.id === selectedNodeId);

  if (!selected) {
    return (
      <div className="inspector">
        <div className="inspector-head">
          <div className="k">Inspector</div>
          <div className="v">No node selected</div>
        </div>
        <div className="inspector-body">
          <div className="hint">Select a node on the canvas to view and edit its configuration.</div>
        </div>
      </div>
    );
  }

  const selectedId = selected.id;
  function patch(data: Record<string, unknown>) {
    setGraph((g) => updateNodeData(g, selectedId, data));
  }

  return (
    <div className="inspector">
      <div className="inspector-head">
        <div className="k">Selected node ({selected.type})</div>
        <div className="v">{selected.label}</div>
      </div>
      <div className="inspector-body">
        <div className="field">
          <label htmlFor="node-label">Label</label>
          <input
            id="node-label"
            className="input"
            value={selected.label}
            onChange={(e) => setGraph((g) => renameNode(g, selected.id, e.target.value))}
          />
        </div>

        {selected.type === 'llm' && (
          <>
            <div className="field">
              <label>Provider &amp; model</label>
              <div className="row2">
                <select
                  className="select"
                  value={selected.data.provider.type}
                  onChange={(e) => patch({ provider: { ...selected.data.provider, type: e.target.value } })}
                >
                  {KNOWN_PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <input
                  className="input"
                  value={selected.data.provider.model}
                  onChange={(e) => patch({ provider: { ...selected.data.provider, model: e.target.value } })}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="node-prompt">System prompt</label>
              <textarea
                id="node-prompt"
                className="textarea"
                value={selected.data.prompt}
                onChange={(e) => patch({ prompt: e.target.value })}
              />
            </div>
          </>
        )}

        {selected.type === 'tool' && (
          <div className="field">
            <label htmlFor="node-tool-name">Tool name</label>
            <input
              id="node-tool-name"
              className="input"
              value={selected.data.toolName}
              onChange={(e) => patch({ toolName: e.target.value })}
            />
          </div>
        )}

        {selected.type === 'trigger' && (
          <div className="field">
            <label htmlFor="node-trigger-type">Trigger type</label>
            <input
              id="node-trigger-type"
              className="input"
              value={selected.data.trigger.type}
              onChange={(e) => patch({ trigger: { ...selected.data.trigger, type: e.target.value } })}
            />
          </div>
        )}

        {selected.type === 'approval' && (
          <div className="field">
            <label>Requires approval</label>
            <span
              className={`chip${selected.data.policy.requiresApproval ? ' on' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() =>
                patch({ policy: { ...selected.data.policy, requiresApproval: !selected.data.policy.requiresApproval } })
              }
            >
              {selected.data.policy.requiresApproval ? 'yes' : 'no'}
            </span>
          </div>
        )}

        {selected.type === 'output' && (
          <div className="field">
            <div className="hint">The output node has no configurable fields today.</div>
          </div>
        )}

        <div className="field">
          <div className="hint">Hooks (pre/post) are wired up in LOU-Q.</div>
        </div>
      </div>
    </div>
  );
}
