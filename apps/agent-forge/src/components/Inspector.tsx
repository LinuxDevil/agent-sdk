import { useAppState } from '../state/AppState';

const KNOWN_TOOLS = ['http', 'current-date', 'day-name'];
const KNOWN_PROVIDERS = ['mock', 'openai', 'anthropic', 'ollama', 'openrouter'];

/**
 * Inspector fields here are limited to what `AgentSpec` actually has a
 * field for (name/prompt/provider/tools/policy.requiresApproval) - the
 * mockup also shows per-node fields like temperature, max-steps and hook
 * wiring that don't exist in `AgentSpec` yet (those are richer per-node
 * config LOU-M's real graph editor will need to add to the spec/schema
 * first). This deliberately edits the single underlying `AgentSpec`
 * directly rather than a selected canvas node, since there is no real
 * canvas/node-selection yet (LOU-M).
 */
export function Inspector() {
  const { spec, setSpec } = useAppState();

  function toggleTool(tool: string) {
    setSpec((prev) => {
      const tools = prev.tools ?? [];
      const has = tools.includes(tool);
      return { ...prev, tools: has ? tools.filter((t) => t !== tool) : [...tools, tool] };
    });
  }

  return (
    <div className="inspector">
      <div className="inspector-head">
        <div className="k">Selected agent</div>
        <div className="v">{spec.name}</div>
      </div>
      <div className="inspector-body">
        <div className="field">
          <label htmlFor="agent-name">Name</label>
          <input
            id="agent-name"
            className="input"
            value={spec.name}
            onChange={(e) => setSpec((prev) => ({ ...prev, name: e.target.value }))}
          />
        </div>
        <div className="field">
          <label>Provider &amp; model</label>
          <div className="row2">
            <select
              className="select"
              value={spec.provider.type}
              onChange={(e) => setSpec((prev) => ({ ...prev, provider: { ...prev.provider, type: e.target.value } }))}
            >
              {KNOWN_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <input
              className="input"
              value={spec.provider.model}
              onChange={(e) =>
                setSpec((prev) => ({ ...prev, provider: { ...prev.provider, model: e.target.value } }))
              }
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="agent-prompt">System prompt</label>
          <textarea
            id="agent-prompt"
            className="textarea"
            value={spec.prompt}
            onChange={(e) => setSpec((prev) => ({ ...prev, prompt: e.target.value }))}
          />
        </div>
        <div className="field">
          <label>Tools enabled</label>
          <div className="chip-list">
            {KNOWN_TOOLS.map((tool) => (
              <span
                key={tool}
                className={`chip${spec.tools?.includes(tool) ? ' on' : ''}`}
                onClick={() => toggleTool(tool)}
                role="button"
                tabIndex={0}
              >
                {tool}
              </span>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Execution</label>
          <div className="hint">
            Requires approval: {spec.policy?.requiresApproval ? 'yes' : 'no'}. Hooks (pre/post) are wired up in
            LOU-Q.
          </div>
        </div>
      </div>
    </div>
  );
}
