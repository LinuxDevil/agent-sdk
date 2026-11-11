import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, GitBranch, ListTree } from 'lucide-react';
import type { ObserveObservationRow, ObserveScoreRow } from '../../observe/types';
import { useAppState } from '../../state/AppState';
import { viewFor } from '../../canvas/kinds';
import type { Graph } from '../../graph/v2/types';
import { Sheet } from '../../ui/Sheet';
import { TraceViewer, type TraceViewMode } from '../../ui/run/TraceViewer';
import { useNow } from '../../ui/run/useNow';
import { lastRunTraceId } from '../RunStatus';
import { spansToObservations } from '../debug/spansToObservations';
import { ForkResult, ReplayEditor, useForkReplay, useRunHistory, type ForkPatch, type ForkView } from '../debug/forkReplay';
import { stepForToolSpan } from './forkFromSpan';
import { spansForNode } from './nodeSpans';
import './nodeSpans.css';
import type { AgentRunStatusPayload, RunHistoryStep, SpanEvent } from '../../../shared/wireTypes';

const NO_SCORES: ObserveScoreRow[] = [];

/** Disabled "Fork from here": a tool call the checkpoint history does not know can not be replayed from a checkpoint. */
const NO_CHECKPOINT_TITLE = 'This call has no checkpoint. Forking needs a checkpointed run of the agent.';

/** The node's display label: its kind's title on the graph, else its id. */
function nodeLabel(graph: Graph, nodeId: string): string {
  const node = graph.nodes.find((n) => n.id === nodeId);
  return node === undefined ? nodeId : viewFor(node.kind).title(node as never, graph);
}

/** A run whose spans may still grow (running or paused at an approval). */
function isLive(runStatus: AgentRunStatusPayload | undefined): boolean {
  return runStatus?.status === 'running' || runStatus?.status === 'paused';
}

/** The sheet's description line: span count plus whether it is this or the last run. */
function spansDescription(count: number, live: boolean): string {
  return `${count} ${count === 1 ? 'span' : 'spans'} from ${live ? 'this run' : 'the last run'}`;
}

/** The footer's "Open trace" link, when the shown run has a trace id. */
function traceFooter(traceId: string | undefined): ReactNode {
  if (traceId === undefined) return undefined;
  return (
    <a className="run-trace-link" href={`#/traces/${encodeURIComponent(traceId)}`} aria-label="Open trace" title="Open this run's trace">
      Open trace
    </a>
  );
}

/** The sheet's empty state: the node owns no spans in the shown run. */
function NoSpans() {
  return (
    <div className="node-spans-empty">
      <span className="node-spans-empty-icon" aria-hidden="true">
        <ListTree size={20} strokeWidth={1.75} />
      </span>
      <p>This node has no spans in the last run.</p>
    </div>
  );
}

/** The fork's "Replaying as <runId>" placeholder, then its comparison with `agentId`, plus a way back to the spans. */
function ForkPane({ fork, agentId, onBack }: { fork: ForkView; agentId: string; onBack: () => void }) {
  return (
    <div className="node-spans-fork">
      <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
        <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        Back to spans
      </button>
      <ForkResult fork={fork} agentId={agentId} />
    </div>
  );
}

/** The span whose "Fork from here" is open, the checkpoint step the fork replays from and the span's tool call id. */
interface ForkTarget {
  span: SpanEvent;
  step: RunHistoryStep;
  callId: string | undefined;
}

/**
 * The open fork target for `forkingSpanId`: the span plus the checkpoint step
 * that produced its call, or `undefined` — the span id is unset, the span is
 * gone, or its call id matches no checkpointed step.
 */
function forkTargetOf(nodeSpans: readonly SpanEvent[], steps: readonly RunHistoryStep[], forkingSpanId: string | undefined): ForkTarget | undefined {
  if (forkingSpanId === undefined) return undefined;
  const span = nodeSpans.find((s) => s.id === forkingSpanId);
  const step = span === undefined ? undefined : stepForToolSpan(steps, span);
  if (span === undefined || step === undefined) return undefined;
  const callId = span.attributes['gen_ai.tool.call.id'];
  return { span, step, callId: typeof callId === 'string' ? callId : undefined };
}

interface SheetBodyProps {
  error: string | undefined;
  forking: ForkTarget | undefined;
  replay: (fromStep: number, patch: ForkPatch) => Promise<boolean>;
  onForked: () => void;
  onCancelFork: () => void;
  showingFork: boolean;
  fork: ForkView | undefined;
  agentId: string;
  onBackToSpans: () => void;
  viewer: ReactNode;
  hasSpans: boolean;
}

/**
 * The sheet's body: a fork error alert when there is one, then the replay
 * editor while a "Fork from here" is open, the fork's comparison after a
 * successful `replay()`, else the node's spans (or the empty state) in the
 * shared `TraceViewer`.
 */
function SheetBody({ error, forking, replay, onForked, onCancelFork, showingFork, fork, agentId, onBackToSpans, viewer, hasSpans }: SheetBodyProps) {
  const submit = async (patch: ForkPatch) => {
    if (forking !== undefined && (await replay(forking.step.step, patch))) onForked();
  };
  let content: ReactNode;
  if (forking !== undefined) {
    content = (
      <ReplayEditor
        key={forking.span.id}
        step={forking.step}
        defaultTarget={forking.callId}
        onFork={(patch) => void submit(patch)}
        onCancel={onCancelFork}
      />
    );
  } else if (showingFork && fork !== undefined) {
    content = <ForkPane fork={fork} agentId={agentId} onBack={onBackToSpans} />;
  } else if (!hasSpans) {
    content = <NoSpans />;
  } else {
    content = viewer;
  }
  return (
    <>
      {error !== undefined && <div className="run-error" role="alert">{error}</div>}
      {content}
    </>
  );
}

/**
 * The open sheet for `spansNodeId`. The run-history fetch and the
 * fork/replay hooks live here (not in {@link NodeSpansSheet}) so nothing is
 * fetched while the sheet is closed.
 */
function SpansSheet({ spansNodeId }: { spansNodeId: string }) {
  const { agentId, closeNodeSpans, displayGraph, spans, runStatus } = useAppState();
  const [mode, setMode] = useState<TraceViewMode>('tree');
  const [selectedObsId, setSelectedObsId] = useState<string | null>(null);
  const [forkingSpanId, setForkingSpanId] = useState<string>();
  const [showingFork, setShowingFork] = useState(false);
  const steps = useRunHistory(agentId, runStatus?.updatedAt);
  const { fork, error, replay } = useForkReplay(agentId);

  // A different node opens with a fresh selection and fork state (the mode carries over).
  useEffect(() => {
    setSelectedObsId(null);
    setForkingSpanId(undefined);
    setShowingFork(false);
  }, [spansNodeId]);

  const nodeSpans = useMemo(() => spansForNode(spans, spansNodeId), [spans, spansNodeId]);
  const observations = useMemo(() => spansToObservations(nodeSpans), [nodeSpans]);
  const now = useNow(nodeSpans.some((span) => span.endTime === undefined));
  const traceId = lastRunTraceId(runStatus, spans);
  const forking = useMemo(() => forkTargetOf(nodeSpans, steps, forkingSpanId), [nodeSpans, steps, forkingSpanId]);
  const toolNode = spansNodeId.startsWith('tool:');

  // A "Fork from here" action under an inspected tool step of a tool node,
  // enabled when the checkpoint history has the step that produced that call.
  const renderForkAction = useCallback(
    (row: ObserveObservationRow) => {
      if (!toolNode || row.kind !== 'tool') return null;
      const span = nodeSpans.find((s) => s.id === row.obs_id);
      if (span === undefined) return null;
      const step = stepForToolSpan(steps, span);
      return (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={step === undefined}
          title={step === undefined ? NO_CHECKPOINT_TITLE : undefined}
          onClick={() => setForkingSpanId(span.id)}
        >
          <GitBranch size={16} strokeWidth={1.75} aria-hidden="true" />
          Fork from here
        </button>
      );
    },
    [toolNode, nodeSpans, steps],
  );

  const count = nodeSpans.length;

  return (
    <Sheet
      open
      onClose={closeNodeSpans}
      size="xl"
      title={`Spans · ${nodeLabel(displayGraph, spansNodeId)}`}
      description={spansDescription(count, isLive(runStatus))}
      footer={traceFooter(traceId)}
    >
      <SheetBody
        error={error}
        forking={forking}
        replay={replay}
        onForked={() => {
          setForkingSpanId(undefined);
          setShowingFork(true);
        }}
        onCancelFork={() => setForkingSpanId(undefined)}
        showingFork={showingFork}
        fork={fork}
        agentId={agentId}
        onBackToSpans={() => setShowingFork(false)}
        hasSpans={count > 0}
        viewer={
          <TraceViewer
            observations={observations}
            scores={NO_SCORES}
            selectedObsId={selectedObsId}
            onSelect={setSelectedObsId}
            mode={mode}
            onModeChange={setMode}
            now={now}
            playgroundLinks={false}
            renderFeedback={renderForkAction}
          />
        }
      />
    </Sheet>
  );
}

/**
 * The node spans sheet (PLAN §11 "Node spans (TraceViewer)"): opened by a
 * node card's status pill or the Inspector's "View spans" button
 * (`AppState.spansNodeId`), it shows only that node's spans — and its
 * subagent children's — of the live/last run in the shared `TraceViewer`.
 * Renders nothing while `spansNodeId` is undefined.
 *
 * On `tool:*` nodes each inspected tool span also offers "Fork from here":
 * when the run's checkpoint history contains the step that produced the
 * call, it opens the shared `ReplayEditor` with that call preselected and
 * replays from it (`POST /runs/:id/fork`); the sheet body then shows the
 * fork's side-by-side comparison until "Back to spans".
 */
export function NodeSpansSheet(): JSX.Element | null {
  const { spansNodeId } = useAppState();
  if (spansNodeId === undefined) return null;
  return <SpansSheet spansNodeId={spansNodeId} />;
}
