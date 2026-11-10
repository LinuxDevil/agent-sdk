import type { ReactNode } from 'react';
import { Activity, MousePointerClick } from 'lucide-react';
import { useAppState } from '../state/AppState';
import { patchNode, setNodeData } from '../graph/v2/mutations';
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
  const { displayGraph, setGraph, proposal, spans, openNodeSpans } = useAppState();
  const selectedId = selected.id;
  const view = viewFor(selected.kind);
  // "View spans" opens the node spans sheet; disabled until the node has
  // spans in the live/last run's feed (components/test/nodeSpans.ts).
  // `?? []`: AppState always provides `spans`, but lightweight test doubles
  // of useAppState may not.
  const spanCount = spansForNode(spans ?? [], selectedId).length;
  const props: KindFieldsProps<typeof selected.kind> = {
    node: selected as never,
    graph: displayGraph,
    patch: (patch) => setGraph((g) => patchNode(g, selectedId, patch)),
    replace: (data) => setGraph((g) => setNodeData(g, selectedId, data)),
    // validateGraph's per-node problems arrive with C19; nothing to show before.
    problems: [] as Problem[],
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
      <div className="inspector-body">
        {/* Collapsible sections, each remembered per viewer (InspectorSection.tsx). */}
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
