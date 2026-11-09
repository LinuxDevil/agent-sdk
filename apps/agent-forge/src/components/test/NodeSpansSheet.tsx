import { useEffect, useMemo, useState } from 'react';
import { ListTree, Pin } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ObserveScoreRow } from '../../observe/types';
import type { ObserveObservationRow } from '../../observe/types';
import { useAppState } from '../../state/AppState';
import { viewFor } from '../../canvas/kinds';
import { Sheet } from '../../ui/Sheet';
import { TraceViewer, type TraceViewMode } from '../../ui/run/TraceViewer';
import { useNow } from '../../ui/run/useNow';
import { lastRunTraceId } from '../RunStatus';
import { spansToObservations } from '../debug/spansToObservations';
import { spansForNode } from './nodeSpans';
import { lastUserInput, pinFromSpan } from '../../state/pins';
import './nodeSpans.css';

const NO_SCORES: ObserveScoreRow[] = [];

/** Why a tool span's pin toggle is disabled (its `title`). */
const NO_RECORDED_RESULT = 'This run did not record the tool result. Turn on content capture to pin it.';

/**
 * The node spans sheet (PLAN §11 "Node spans (TraceViewer)"): opened by a
 * node card's status pill or the Inspector's "View spans" button
 * (`AppState.spansNodeId`), it shows only that node's spans — and its
 * subagent children's — of the live/last run in the shared `TraceViewer`.
 * Renders nothing while `spansNodeId` is undefined.
 *
 * On a tool node (T04) each tool span row also carries a "Pin this
 * result"/"Unpin" toggle, and the footer a "Run from here" button that
 * re-runs the agent from the last user input with the pinned results
 * replayed instead of re-executed.
 */
export function NodeSpansSheet(): JSX.Element | null {
  const {
    spansNodeId,
    closeNodeSpans,
    displayGraph,
    spans,
    runStatus,
    chat,
    pins,
    togglePin,
    clearPins,
    isPinned,
    runFromHere,
  } = useAppState();
  const [mode, setMode] = useState<TraceViewMode>('tree');
  const [selectedObsId, setSelectedObsId] = useState<string | null>(null);

  // A different node opens with a fresh selection (the mode carries over).
  useEffect(() => {
    setSelectedObsId(null);
  }, [spansNodeId]);

  const nodeSpans = useMemo(
    () => (spansNodeId === undefined ? [] : spansForNode(spans, spansNodeId)),
    [spans, spansNodeId]
  );
  const observations = useMemo(() => spansToObservations(nodeSpans), [nodeSpans]);
  const now = useNow(nodeSpans.some((span) => span.endTime === undefined));
  const traceId = lastRunTraceId(runStatus, spans);
  const spanById = useMemo(() => new Map(nodeSpans.map((span) => [span.id, span])), [nodeSpans]);

  if (spansNodeId === undefined) return null;

  const node = displayGraph.nodes.find((n) => n.id === spansNodeId);
  const label = node === undefined ? spansNodeId : viewFor(node.kind).title(node as never, displayGraph);
  const live = runStatus?.status === 'running' || runStatus?.status === 'paused';
  const count = nodeSpans.length;
  // Pin actions exist on tool nodes only (the `tool:<key>` canvas ids).
  const isToolNode = node?.kind === 'tool';

  /** The row's pin toggle, or undefined for non-tool rows (the viewer keeps its default slot). */
  const rowAction = (row: ObserveObservationRow): ReactNode => {
    if (!isToolNode || row.kind !== 'tool') return undefined;
    const span = spanById.get(row.obs_id);
    const pin = span === undefined ? undefined : pinFromSpan(spansNodeId, span);
    const pinned = pin !== undefined && isPinned(pin);
    return (
      <button
        type="button"
        className="node-pin-toggle"
        aria-pressed={pinned}
        disabled={pin === undefined}
        title={pin === undefined ? NO_RECORDED_RESULT : pinned ? 'Stop replaying this result' : 'Replay this result on the next run'}
        onClick={(event) => {
          event.stopPropagation();
          if (pin !== undefined) togglePin(pin);
        }}
      >
        <Pin size={12} strokeWidth={1.75} aria-hidden="true" />
        {pinned ? 'Unpin' : 'Pin this result'}
      </button>
    );
  };

  const hasInput = lastUserInput(chat.messages) !== undefined;
  const runDisabledReason = live ? 'Wait for the current run to finish' : !hasInput ? 'Send a message first' : undefined;

  return (
    <Sheet
      open
      onClose={closeNodeSpans}
      size="xl"
      title={`Spans · ${label}`}
      description={`${count} ${count === 1 ? 'span' : 'spans'} from ${live ? 'this run' : 'the last run'}`}
      footer={
        <div className="node-spans-footer">
          {isToolNode && (
            <>
              <span className="node-pins-chip" title="Tool results replayed by Run from here">
                {pins.length} pinned
              </span>
              {pins.length > 0 && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={clearPins}>
                  Clear
                </button>
              )}
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={runDisabledReason !== undefined}
                title={runDisabledReason}
                onClick={() => void runFromHere()}
              >
                Run from here
              </button>
            </>
          )}
          {traceId !== undefined && (
            <a className="run-trace-link" href={`#/traces/${encodeURIComponent(traceId)}`} aria-label="Open trace" title="Open this run's trace">
              Open trace
            </a>
          )}
        </div>
      }
    >
      {count === 0 ? (
        <div className="node-spans-empty">
          <span className="node-spans-empty-icon" aria-hidden="true">
            <ListTree size={20} strokeWidth={1.75} />
          </span>
          <p>This node has no spans in the last run.</p>
        </div>
      ) : (
        <TraceViewer
          observations={observations}
          scores={NO_SCORES}
          selectedObsId={selectedObsId}
          onSelect={setSelectedObsId}
          mode={mode}
          onModeChange={setMode}
          now={now}
          playgroundLinks={false}
          rowAction={isToolNode ? rowAction : undefined}
        />
      )}
    </Sheet>
  );
}
