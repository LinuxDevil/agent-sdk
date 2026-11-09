import { useEffect, useMemo, useState } from 'react';
import { ListTree } from 'lucide-react';
import type { ObserveScoreRow } from '../../observe/types';
import { useAppState } from '../../state/AppState';
import { viewFor } from '../../canvas/kinds';
import { Sheet } from '../../ui/Sheet';
import { TraceViewer, type TraceViewMode } from '../../ui/run/TraceViewer';
import { useNow } from '../../ui/run/useNow';
import { lastRunTraceId } from '../RunStatus';
import { spansToObservations } from '../debug/spansToObservations';
import { spansForNode } from './nodeSpans';
import './nodeSpans.css';

const NO_SCORES: ObserveScoreRow[] = [];

/**
 * The node spans sheet (PLAN §11 "Node spans (TraceViewer)"): opened by a
 * node card's status pill or the Inspector's "View spans" button
 * (`AppState.spansNodeId`), it shows only that node's spans — and its
 * subagent children's — of the live/last run in the shared `TraceViewer`.
 * Renders nothing while `spansNodeId` is undefined.
 */
export function NodeSpansSheet(): JSX.Element | null {
  const { spansNodeId, closeNodeSpans, displayGraph, spans, runStatus } = useAppState();
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

  if (spansNodeId === undefined) return null;

  const node = displayGraph.nodes.find((n) => n.id === spansNodeId);
  const label = node === undefined ? spansNodeId : viewFor(node.kind).title(node as never, displayGraph);
  const live = runStatus?.status === 'running' || runStatus?.status === 'paused';
  const count = nodeSpans.length;

  return (
    <Sheet
      open
      onClose={closeNodeSpans}
      size="xl"
      title={`Spans · ${label}`}
      description={`${count} ${count === 1 ? 'span' : 'spans'} from ${live ? 'this run' : 'the last run'}`}
      footer={
        traceId !== undefined ? (
          <a className="run-trace-link" href={`#/traces/${encodeURIComponent(traceId)}`} aria-label="Open trace" title="Open this run's trace">
            Open trace
          </a>
        ) : undefined
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
        />
      )}
    </Sheet>
  );
}
