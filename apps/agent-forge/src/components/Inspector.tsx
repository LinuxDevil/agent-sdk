import { useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { useAppState } from '../state/AppState';
import {
  updateNodeData,
  renameNode,
  addHookToNode,
  toggleNodeHook,
  updateNodeHookCode,
  removeNodeHook,
  removeEdge,
  updateEdgeCondition,
} from '../canvas/graphMutations';
import { HOOK_TEMPLATES } from '../hooks/hookTemplates';
import type { AgentGraphEdge, AgentGraphNode, AgentGraphSpec, AgentNodeHookInstance } from '../graph/types';

type SetGraph = (updater: (graph: AgentGraphSpec) => AgentGraphSpec) => void;
type PatchNode = (data: Record<string, unknown>) => void;
type NodeOf<T extends AgentGraphNode['type']> = Extract<AgentGraphNode, { type: T }>;

const KNOWN_PROVIDERS = ['mock', 'openai', 'anthropic', 'ollama', 'openrouter'];

interface HookChipProps {
  node: AgentGraphNode;
  hook: AgentNodeHookInstance;
  selected: boolean;
  setGraph: SetGraph;
  onSelect: () => void;
  onRemoved: () => void;
}

function HookToggleSwitch({ hook, onToggle }: { hook: AgentNodeHookInstance; onToggle: () => void }) {
  return (
    <div
      className={`switch${hook.enabled ? ' on' : ''}`}
      role="button"
      tabIndex={0}
      title={hook.enabled ? 'Disable this hook' : 'Enable this hook'}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    />
  );
}

function HookWhen({ hook }: { hook: AgentNodeHookInstance }) {
  return (
    <span className="hook-chip-when">
      {hook.phase === 'pre' ? 'before' : 'after'} {hook.point === 'toolCall' ? 'tool.call' : 'llm.generate'}
    </span>
  );
}

function HookChip({ node, hook, selected, setGraph, onSelect, onRemoved }: HookChipProps) {
  return (
    <div
      className={`hook-chip${selected ? ' selected' : ''}`}
      data-hook={hook.name}
      role="button"
      tabIndex={0}
      onClick={onSelect}
    >
      <HookToggleSwitch hook={hook} onToggle={() => setGraph((g) => toggleNodeHook(g, node.id, hook.id))} />
      <span className="hook-chip-name">{hook.name}</span>
      <HookWhen hook={hook} />
      <button
        className="btn btn-ghost"
        style={{ padding: '2px 6px' }}
        title="Remove this hook"
        onClick={(e) => {
          e.stopPropagation();
          setGraph((g) => removeNodeHook(g, node.id, hook.id));
          onRemoved();
        }}
      >
        &times;
      </button>
    </div>
  );
}

interface HookGroupProps {
  label: string;
  hooks: AgentNodeHookInstance[];
  renderChip: (hook: AgentNodeHookInstance) => JSX.Element;
}

function HookGroup({ label, hooks, renderChip }: HookGroupProps) {
  return (
    <div className="hook-group">
      <div className="hook-group-label">
        {label} <span className="hook-count">({hooks.filter((h) => h.enabled).length} active)</span>
      </div>
      {hooks.map(renderChip)}
    </div>
  );
}

function HookTemplateButtons({ node, setGraph }: { node: AgentGraphNode; setGraph: SetGraph }) {
  const point = node.type === 'llm' ? 'generate' : 'toolCall';
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
      {HOOK_TEMPLATES.filter((t) => t.point === point).map((t) => (
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
  );
}

function useHookSelection(hooks: AgentNodeHookInstance[]) {
  const [selectedHookId, setSelectedHookId] = useState<string | undefined>(hooks[0]?.id);
  const selectedHook: AgentNodeHookInstance | undefined = hooks.find((h) => h.id === selectedHookId) ?? hooks[0];
  return { selectedHookId, setSelectedHookId, selectedHook };
}

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
  const { selectedHookId, setSelectedHookId, selectedHook } = useHookSelection(hooks);

  const renderChip = (hook: AgentNodeHookInstance) => (
    <HookChip
      key={hook.id}
      node={node}
      hook={hook}
      selected={selectedHook?.id === hook.id}
      setGraph={setGraph}
      onSelect={() => setSelectedHookId(hook.id)}
      onRemoved={() => {
        if (selectedHookId === hook.id) setSelectedHookId(undefined);
      }}
    />
  );

  return (
    <div className="field">
      <label>Hooks</label>
      <HookGroup label="Pre-call" hooks={hooks.filter((h) => h.phase === 'pre')} renderChip={renderChip} />
      <HookGroup label="Post-call" hooks={hooks.filter((h) => h.phase === 'post')} renderChip={renderChip} />

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

      <HookTemplateButtons node={node} setGraph={setGraph} />
    </div>
  );
}

interface BranchRowProps {
  edge: AgentGraphEdge;
  target: AgentGraphNode | undefined;
  setGraph: SetGraph;
}

function isDefaultBranch(edge: AgentGraphEdge): boolean {
  return !edge.condition?.trim();
}

function branchTargetLabel(edge: AgentGraphEdge, target: AgentGraphNode | undefined): string {
  return target?.label ?? edge.target;
}

function BranchRow({ edge, target, setGraph }: BranchRowProps) {
  return (
    <div className="branch-row" style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span className="hint" style={{ flex: 1 }}>
          &rarr; {branchTargetLabel(edge, target)}
          {isDefaultBranch(edge) && ' (default)'}
        </span>
        <button
          className="btn btn-ghost"
          style={{ padding: '2px 6px' }}
          title="Remove this branch"
          onClick={() => setGraph((g) => removeEdge(g, edge.id))}
        >
          &times;
        </button>
      </div>
      <input
        className="input"
        placeholder="Condition, e.g. '{{classify}}' === 'refund' (quote the placeholder; blank = default branch)"
        value={edge.condition ?? ''}
        onChange={(e) => setGraph((g) => updateEdgeCondition(g, edge.id, e.target.value))}
      />
    </div>
  );
}

/**
 * LOU-T3: branch editor for a `router` node - lists its outgoing edges
 * (each one IS a branch; see `graph/types.ts`'s `AgentGraphEdge.condition`),
 * with an editable condition expression per branch and a remove button.
 * "Add a branch" isn't a button here: a branch is created by dragging a new
 * connection off the router node on the canvas (the same `connectNodes()`
 * path every other edge is made through - no second mutation path, per the
 * epic's "graphMutations.ts is the only way the canvas mutates graph state"
 * constraint), so this section's hint just points at that.
 *
 * The condition text is the literal `{{variable}} expression` string
 * `FlowExecutor.evaluateCondition()` interpolates and `eval()`s at runtime
 * (see `graphToFlow.ts`'s doc comment) - e.g. `'{{classify}}' === 'refund'`
 * (the placeholder itself must be quoted when comparing a string value -
 * `graphToFlow.ts` explains why). Leaving it blank makes that branch the router's default (taken when no
 * earlier branch's condition is true); `validateGraph.ts` flags it if more
 * than one branch is left blank.
 */
function BranchesField({ node, graph, setGraph }: { node: AgentGraphNode; graph: AgentGraphSpec; setGraph: SetGraph }) {
  const branches = graph.edges.filter((e) => e.source === node.id);
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));

  return (
    <div className="field">
      <label>Branches ({branches.length})</label>
      {branches.length === 0 && (
        <div className="hint">
          No branches yet - drag a connection from this router to another node on the canvas to add one. A router
          needs at least 2 branches to actually route.
        </div>
      )}
      {branches.map((edge) => (
        <BranchRow key={edge.id} edge={edge} target={nodesById.get(edge.target)} setGraph={setGraph} />
      ))}
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

function LlmFields({ node, patch }: { node: NodeOf<'llm'>; patch: PatchNode }) {
  return (
    <>
      <div className="field">
        <label>Provider &amp; model</label>
        <div className="row2">
          <select
            className="select"
            value={node.data.provider.type}
            onChange={(e) => patch({ provider: { ...node.data.provider, type: e.target.value } })}
          >
            {KNOWN_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <input
            className="input"
            value={node.data.provider.model}
            onChange={(e) => patch({ provider: { ...node.data.provider, model: e.target.value } })}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="node-prompt">System prompt</label>
        <textarea
          id="node-prompt"
          className="textarea"
          value={node.data.prompt}
          onChange={(e) => patch({ prompt: e.target.value })}
        />
      </div>
    </>
  );
}

function ToolFields({ node, patch }: { node: NodeOf<'tool'>; patch: PatchNode }) {
  return (
    <div className="field">
      <label htmlFor="node-tool-name">Tool name</label>
      <input
        id="node-tool-name"
        className="input"
        value={node.data.toolName}
        onChange={(e) => patch({ toolName: e.target.value })}
      />
    </div>
  );
}

function TriggerFields({ node, patch }: { node: NodeOf<'trigger'>; patch: PatchNode }) {
  return (
    <div className="field">
      <label htmlFor="node-trigger-type">Trigger type</label>
      <input
        id="node-trigger-type"
        className="input"
        value={node.data.trigger.type}
        onChange={(e) => patch({ trigger: { ...node.data.trigger, type: e.target.value } })}
      />
    </div>
  );
}

function ApprovalFields({ node, patch }: { node: NodeOf<'approval'>; patch: PatchNode }) {
  const { requiresApproval } = node.data.policy;
  return (
    <div className="field">
      <label>Requires approval</label>
      <span
        className={`chip${requiresApproval ? ' on' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => patch({ policy: { ...node.data.policy, requiresApproval: !requiresApproval } })}
      >
        {requiresApproval ? 'yes' : 'no'}
      </span>
    </div>
  );
}

function OutputFields() {
  return (
    <div className="field">
      <div className="hint">The output node has no configurable fields today.</div>
    </div>
  );
}

type NodeType = AgentGraphNode['type'];

interface FieldProps<T extends NodeType> {
  node: NodeOf<T>;
  graph: AgentGraphSpec;
  setGraph: SetGraph;
  patch: PatchNode;
}

type FieldComponents = { [T in NodeType]: (props: FieldProps<T>) => JSX.Element };

const NODE_FIELD_COMPONENTS: FieldComponents = {
  llm: LlmFields,
  tool: ToolFields,
  trigger: TriggerFields,
  approval: ApprovalFields,
  output: OutputFields,
  router: BranchesField,
};

/** The type-specific fields for the selected node (everything below the shared Label field). */
function NodeTypeFields<T extends NodeType>(props: FieldProps<T>) {
  const Fields = NODE_FIELD_COMPONENTS[props.node.type as T] as (p: FieldProps<T>) => JSX.Element;
  return <Fields {...props} />;
}

/** Breakpoint key for nodes that support breakpoints (llm/tool); undefined for the rest. */
function breakpointKeyFor(node: AgentGraphNode): string | undefined {
  if (node.type === 'llm') return 'llm:before';
  if (node.type === 'tool') return `tool:${node.data.toolName}:before`;
  return undefined;
}

function EmptyInspector() {
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

function breakpointsOf(debugState: ReturnType<typeof useAppState>['debugState']): string[] {
  return debugState?.breakpoints ?? [];
}

function BreakpointSection({ breakpointKey }: { breakpointKey: string }) {
  const { debugMode, debugState, setBreakpoints } = useAppState();
  if (!debugMode) return null;
  return (
    <BreakpointField
      breakpointKey={breakpointKey}
      breakpoints={breakpointsOf(debugState)}
      setBreakpoints={setBreakpoints}
    />
  );
}

function NodeInspector({ selected }: { selected: AgentGraphNode }) {
  const { graph, setGraph } = useAppState();
  const selectedId = selected.id;
  const patch: PatchNode = (data) => setGraph((g) => updateNodeData(g, selectedId, data));
  const breakpointKey = breakpointKeyFor(selected);

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

        <NodeTypeFields node={selected} graph={graph} setGraph={setGraph} patch={patch} />

        {breakpointKey && (
          <>
            <BreakpointSection breakpointKey={breakpointKey} />
            <HooksField node={selected} setGraph={setGraph} />
          </>
        )}
      </div>
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
  const { graph, selectedNodeId } = useAppState();
  const selected = graph.nodes.find((n) => n.id === selectedNodeId);
  return selected ? <NodeInspector selected={selected} /> : <EmptyInspector />;
}
