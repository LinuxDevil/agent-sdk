import { useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { useAppState } from '../state/AppState';
import { updateNodeData, renameNode, addHookToNode, toggleNodeHook, updateNodeHookCode, removeNodeHook } from '../canvas/graphMutations';
import { HOOK_TEMPLATES } from '../hooks/hookTemplates';
import type { AgentGraphNode, AgentGraphSpec, AgentNodeHookInstance } from '../graph/types';

type SetGraph = (updater: (graph: AgentGraphSpec) => AgentGraphSpec) => void;

const KNOWN_PROVIDERS = ['mock', 'openai', 'anthropic', 'ollama', 'openrouter'];

/**
 * LOU-Q2: Hooks section of the Inspector - lists pre/post-call hooks
 * attached to the selected node (see graph/types.ts's
 * `AgentNodeHookInstance`), lets you toggle each on/off, add one from a
 * starter template (LOU-Q2's redact-pii/rate-limit/audit-log/
 * inject-context), and edit its code body in a real CodeMirror editor
 * (replacing the mockup's static `.hook-code` preview - see
 * `.design-ref/agent-forge-mockup.html`). Only rendered for `llm`/`tool`
 * nodes, the two node types a `toolCall`/`generate` hook can meaningfully
 * attach to.
 *
 * Editing here only changes `AgentGraphSpec` client-side; the code is never
 * executed in the browser. It's sandboxed server-side (see
 * server/hookSandbox.ts) the same way tool `sandboxExecute()` is, the next
 * time this agent is actually run - see graphToSpec.ts for how an enabled
 * hook's code reaches the server via `spec.policy.hooks`.
 */
function HooksField({ node, setGraph }: { node: AgentGraphNode; setGraph: SetGraph }) {
  const hooks = node.hooks ?? [];
  const preHooks = hooks.filter((h) => h.phase === 'pre');
  const postHooks = hooks.filter((h) => h.phase === 'post');
  const [selectedHookId, setSelectedHookId] = useState<string | undefined>(hooks[0]?.id);
  const selectedHook: AgentNodeHookInstance | undefined = hooks.find((h) => h.id === selectedHookId) ?? hooks[0];

  function renderChip(hook: AgentNodeHookInstance) {
    return (
      <div
        key={hook.id}
        className={`hook-chip${selectedHook?.id === hook.id ? ' selected' : ''}`}
        data-hook={hook.name}
        role="button"
        tabIndex={0}
        onClick={() => setSelectedHookId(hook.id)}
      >
        <div
          className={`switch${hook.enabled ? ' on' : ''}`}
          role="button"
          tabIndex={0}
          title={hook.enabled ? 'Disable this hook' : 'Enable this hook'}
          onClick={(e) => {
            e.stopPropagation();
            setGraph((g) => toggleNodeHook(g, node.id, hook.id));
          }}
        />
        <span className="hook-chip-name">{hook.name}</span>
        <span className="hook-chip-when">
          {hook.phase === 'pre' ? 'before' : 'after'} {hook.point === 'toolCall' ? 'tool.call' : 'llm.generate'}
        </span>
        <button
          className="btn btn-ghost"
          style={{ padding: '2px 6px' }}
          title="Remove this hook"
          onClick={(e) => {
            e.stopPropagation();
            setGraph((g) => removeNodeHook(g, node.id, hook.id));
            if (selectedHookId === hook.id) setSelectedHookId(undefined);
          }}
        >
          &times;
        </button>
      </div>
    );
  }

  return (
    <div className="field">
      <label>Hooks</label>
      <div className="hook-group">
        <div className="hook-group-label">
          Pre-call <span className="hook-count">({preHooks.filter((h) => h.enabled).length} active)</span>
        </div>
        {preHooks.map(renderChip)}
      </div>
      <div className="hook-group">
        <div className="hook-group-label">
          Post-call <span className="hook-count">({postHooks.filter((h) => h.enabled).length} active)</span>
        </div>
        {postHooks.map(renderChip)}
      </div>

      {selectedHook && (
        <div className="hook-code">
          <CodeMirror
            value={selectedHook.code}
            height="160px"
            extensions={[javascript()]}
            onChange={(value) => setGraph((g) => updateNodeHookCode(g, node.id, selectedHook.id, value))}
          />
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        {HOOK_TEMPLATES.filter((t) => t.point === (node.type === 'llm' ? 'generate' : 'toolCall')).map((t) => (
          <button
            key={t.id}
            className="btn btn-add-hook"
            title={`Add ${t.name} (${t.when})`}
            onClick={() => setGraph((g) => addHookToNode(g, node.id, t))}
          >
            + {t.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * O3: breakpoint toggle for an llm/tool node's Inspector panel, shown only
 * in debug mode. Breaks "before" that node runs - see
 * server/debugController.ts's doc comment for why `before`/`after` on an
 * llm/tool hook is the real granularity AgentExecutor's control surface
 * supports (no per-line/per-node-inside-a-call breakpoints).
 */
function BreakpointField({
  breakpointKey,
  breakpoints,
  setBreakpoints,
}: {
  breakpointKey: string;
  breakpoints: string[];
  setBreakpoints: (breakpoints: string[]) => Promise<void>;
}) {
  const on = breakpoints.includes(breakpointKey);
  return (
    <div className="field">
      <label>Breakpoint</label>
      <span
        className={`breakpoint-toggle${on ? ' on' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() =>
          void setBreakpoints(on ? breakpoints.filter((b) => b !== breakpointKey) : [...breakpoints, breakpointKey])
        }
      >
        {on ? 'Break before this node ●' : 'Break before this node'}
      </span>
    </div>
  );
}

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
  const { graph, setGraph, selectedNodeId, debugMode, debugState, setBreakpoints } = useAppState();
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

        {debugMode && (selected.type === 'llm' || selected.type === 'tool') && (
          <BreakpointField
            breakpointKey={
              selected.type === 'llm' ? 'llm:before' : `tool:${selected.data.toolName}:before`
            }
            breakpoints={debugState?.breakpoints ?? []}
            setBreakpoints={setBreakpoints}
          />
        )}

        {(selected.type === 'llm' || selected.type === 'tool') && <HooksField node={selected} setGraph={setGraph} />}
      </div>
    </div>
  );
}
