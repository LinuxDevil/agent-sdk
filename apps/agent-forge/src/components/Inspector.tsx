import { useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Activity, CircleAlert, MousePointerClick, TriangleAlert } from 'lucide-react';
import { useAppState } from '../state/AppState';
import { patchFlowMeta, patchNode, setNodeData } from '../graph/v2/mutations';
import { reorderChild, setOptionCondition } from '../graph/v2/kinds/flow';
import { toolNodeName } from '../graph/v2/nodeIds';
import type { Graph, GraphNode, Problem, ToolNodeData } from '../graph/v2/types';
import { ROOT_AGENT_ID } from '../graph/v2/types';
import { viewFor, type KindFieldsProps } from '../canvas/kinds';
import { spansForNode } from './test/nodeSpans';
import { InspectorSection } from './InspectorSection';

/**
 * Breakpoint toggle for the root agent / a tool node's Inspector panel,
 * shown only in debug mode. Breaks "before" that node runs - see
 * server/debugController.ts's doc comment for why `before` on an
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
      <label htmlFor="node-breakpoint">Breakpoint</label>
      {/* A native toggle button (Enter/Space, announced as pressed). */}
      <button
        type="button"
        id="node-breakpoint"
        className={`breakpoint-toggle${on ? ' on' : ''}`}
        aria-pressed={on}
        onClick={() =>
          void setBreakpoints(on ? breakpoints.filter((b) => b !== breakpointKey) : [...breakpoints, breakpointKey])
        }
      >
        <span className="breakpoint-dot" aria-hidden="true" />
        Break before this node
      </button>
    </div>
  );
}

/** Breakpoint key for nodes that support breakpoints (root agent → `llm:before`; tool → `tool:<name>:before`). */
function breakpointKeyFor(node: GraphNode): string | undefined {
  if (node.kind === 'agent' && node.id === ROOT_AGENT_ID) return 'llm:before';
  if (node.kind === 'tool') return `tool:${toolNodeName((node.data as ToolNodeData).item)}:before`;
  return undefined;
}

/** The header: the node's kind icon tile, its view label as an overline, its title (truncated, full text in the tooltip) and an optional action. */
function InspectorHead({ node, graph, action }: { node: GraphNode; graph: Graph; action?: ReactNode }) {
  const view = viewFor(node.kind);
  const { Icon } = view;
  return (
    <div className="inspector-head">
      <span className={`node-kind node-kind-lg kind-${view.toneFor?.(node as never) ?? view.tone}`} aria-hidden="true">
        <Icon size={16} strokeWidth={1.75} />
      </span>
      <div className="inspector-head-text">
        <div className="k overline">Selected node ({view.label})</div>
        <div className="v" title={view.title(node as never, graph)}>
          {view.title(node as never, graph)}
        </div>
      </div>
      {action}
    </div>
  );
}

function EmptyInspector() {
  return (
    <aside className="inspector" id="studio-inspector" aria-label="Inspector">
      <div className="inspector-head">
        <div className="inspector-head-text">
          <div className="k overline">Inspector</div>
        </div>
      </div>
      <div className="inspector-body inspector-empty">
        <span className="inspector-empty-icon" aria-hidden="true">
          <MousePointerClick size={20} strokeWidth={1.75} />
        </span>
        <div className="inspector-empty-title">No node selected</div>
        <div className="hint">Select a node on the canvas to view and edit its configuration.</div>
      </div>
    </aside>
  );
}

/**
 * The spec-path suffix a problem's `fieldPath` has inside its node:
 * `tools[0].builtin` on the `tools[0]` node is `.builtin`; on the root
 * agent (`''` spec path) it is the whole path. `undefined` when the
 * problem carries no field path.
 */
function fieldSuffix(fieldPath: string | undefined, specPath: string | undefined): string | undefined {
  if (fieldPath === undefined || fieldPath === '') return fieldPath === '' ? '' : undefined;
  if (specPath === undefined || specPath === '') return fieldPath;
  if (fieldPath === specPath) return '';
  if (fieldPath.startsWith(specPath)) return fieldPath.slice(specPath.length);
  return fieldPath;
}

/**
 * Best-effort focus of the control registered for a spec-path suffix:
 * controls carry `data-field-path` (the `Field` component's `fieldPath`
 * prop, the canvas field kit's `fieldPath`). Tries the suffix with and
 * without its leading dot, then focuses the first control inside the
 * matched `.field` row.
 */
function focusFieldPath(root: HTMLElement, suffix: string | undefined): void {
  if (suffix === undefined || suffix === '') return;
  const candidates = [suffix, suffix.replace(/^\./, '')];
  for (const candidate of candidates) {
    if (candidate === '') continue;
    let el: HTMLElement | null = null;
    try {
      el = root.querySelector<HTMLElement>(`[data-field-path="${CSS.escape(candidate)}"]`);
    } catch {
      el = null;
    }
    const control =
      el === null
        ? null
        : el.matches('input, select, textarea, button, [tabindex]')
          ? el
          : el.querySelector<HTMLElement>('input, select, textarea, button, [tabindex]');
    if (control !== null) {
      control.scrollIntoView?.({ block: 'nearest' });
      control.focus();
      return;
    }
  }
}

/** The Inspector's top section (C19): the selected node's problems, each focusing its field on click. */
function ProblemsSection({
  problems,
  specPath,
  rootRef,
}: {
  problems: Problem[];
  specPath: string | undefined;
  rootRef: RefObject<HTMLElement | null>;
}) {
  return (
    <InspectorSection id="problems" title={`Problems (${problems.length})`}>
      <ul className="inspector-problems">
        {problems.map((problem, index) => {
          const Icon = problem.severity === 'error' ? CircleAlert : TriangleAlert;
          const suffix = fieldSuffix(problem.fieldPath, specPath);
          return (
            <li key={index}>
              <button
                type="button"
                className={`inspector-problem inspector-problem-${problem.severity}`}
                disabled={suffix === undefined}
                onClick={() => {
                  if (rootRef.current !== null) focusFieldPath(rootRef.current, suffix);
                }}
              >
                <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
                <span className="inspector-problem-message">{problem.message}</span>
                {problem.fieldPath !== undefined && problem.fieldPath !== '' && (
                  <code className="inspector-problem-field">{problem.fieldPath}</code>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </InspectorSection>
  );
}

function breakpointsOf(debugState: ReturnType<typeof useAppState>['debugState']): string[] {
  return debugState?.breakpoints ?? [];
}

function BreakpointSection({ breakpointKey }: { breakpointKey: string }) {
  const { debugMode, debugState, setBreakpoints } = useAppState();
  if (!debugMode) return null;
  return (
    <InspectorSection id="debug" title="Debug">
      <BreakpointField
        breakpointKey={breakpointKey}
        breakpoints={breakpointsOf(debugState)}
        setBreakpoints={setBreakpoints}
      />
    </InspectorSection>
  );
}

function NodeInspector({ selected }: { selected: GraphNode }) {
  const { displayGraph, setGraph, proposal, spans, openNodeSpans, problems, specPaths } = useAppState();
  const selectedId = selected.id;
  const view = viewFor(selected.kind);
  // `?? []`: AppState always provides `problems`, but lightweight test doubles
  // of useAppState may not (same caveat as `spans` below).
  const nodeProblems = (problems ?? []).filter((p) => p.nodeId === selectedId);
  const bodyRef = useRef<HTMLDivElement>(null);
  // "View spans" opens the node spans sheet; disabled until the node has
  // spans in the live/last run's feed (components/test/nodeSpans.ts).
  // `?? []`: AppState always provides `spans`, but lightweight test doubles
  // of useAppState may not.
  const spanCount = spansForNode(spans ?? [], selectedId).length;
  const props: KindFieldsProps<typeof selected.kind> = {
    node: selected as never,
    graph: displayGraph,
    // Field edits coalesce per node+key into one undo step while typing
    // (C20): 'field:<nodeId>:<firstPatchKey>' within COALESCE_MS.
    patch: (patch) =>
      setGraph((g) => patchNode(g, selectedId, patch), {
        history: { label: 'Edit', coalesceKey: `field:${selectedId}:${Object.keys(patch)[0] ?? ''}` },
      }),
    replace: (data) => setGraph((g) => setNodeData(g, selectedId, data)),
    patchFlowMeta: (patch) =>
      setGraph((g) => patchFlowMeta(g, selectedId, patch), {
        history: { label: 'Edit flow', coalesceKey: `flowmeta:${selectedId}:${Object.keys(patch)[0] ?? ''}` },
      }),
    moveChild: (childId, delta) =>
      setGraph((g) => reorderChild(g, selectedId, childId, delta), {
        history: { label: 'Reorder step', coalesceKey: `floworder:${selectedId}` },
      }),
    setOptionCondition: (childId, condition) =>
      setGraph((g) => setOptionCondition(g, selectedId, childId, condition), {
        history: { label: 'Edit condition', coalesceKey: `flowcond:${selectedId}:${childId}` },
      }),
    problems: nodeProblems,
  };
  const breakpointKey = breakpointKeyFor(selected);
  const Fields = view.Fields as (p: typeof props) => JSX.Element;

  return (
    <aside className="inspector" id="studio-inspector" aria-label="Inspector">
      <InspectorHead
        node={selected}
        graph={displayGraph}
        action={
          <button
            type="button"
            className="btn btn-ghost btn-sm inspector-view-spans"
            disabled={spanCount === 0}
            title={spanCount === 0 ? 'Run the agent to see spans for this node' : undefined}
            onClick={() => openNodeSpans(selectedId)}
          >
            <Activity size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>View spans</span>
          </button>
        }
      />
      <div className="inspector-body" ref={bodyRef}>
        {/* Collapsible sections, each remembered per viewer (InspectorSection.tsx). */}
        {nodeProblems.length > 0 && (
          <ProblemsSection problems={nodeProblems} specPath={specPaths[selectedId]} rootRef={bodyRef} />
        )}
        <InspectorSection id="node" title="Settings">
          {proposal === undefined ? (
            <Fields {...props} />
          ) : (
            <>
              {/* Read-only while the proposal overlay is shown (C21): the
                  fields render the PROPOSED data, edits wait for Apply. */}
              <p className="hint inspector-proposal-hint">This is a proposal. Apply it from the chat to edit.</p>
              <fieldset disabled className="inspector-proposal-fieldset">
                <Fields {...props} />
              </fieldset>
            </>
          )}
        </InspectorSection>
        {breakpointKey && <BreakpointSection breakpointKey={breakpointKey} />}
      </div>
    </aside>
  );
}

/**
 * Inspector: reflects and edits whichever canvas node is currently
 * selected, wired through `AppState.graph`/`selectedNodeId` - the same
 * mechanism the canvas itself reads/writes (see CanvasArea.tsx), so there
 * is exactly one source of truth for node data. Each kind renders its
 * `KindView.Fields` (the generic JSON editor until a kind ticket
 * registers one).
 */
export function Inspector() {
  // The Inspector reads the DISPLAY graph: while a proposal is shown the
  // selected node's fields are the proposed ones (C21).
  const { displayGraph, selectedNodeId } = useAppState();
  const selected = displayGraph.nodes.find((n) => n.id === selectedNodeId);
  return selected ? <NodeInspector selected={selected} /> : <EmptyInspector />;
}
