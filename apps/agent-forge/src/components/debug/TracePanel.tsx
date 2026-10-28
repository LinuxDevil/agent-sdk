import { useEffect, useMemo, useState } from 'react';
import { useAppState } from '../../state/AppState';
import type { SpanEvent, TraceSummaryPayload } from '../../../shared/wireTypes';
import type { ObserveScoreRow } from '../../observe/types';
import { TraceViewer, type TraceViewMode } from '../../ui/run/TraceViewer';
import { useNow } from '../../ui/run/useNow';
import { runtimeClient } from '../../runtime/runtimeClient';
import { errorMessage } from '../errorMessage';
import { nodeIdForSpan } from './nodeLookup';
import { spansToObservations } from './spansToObservations';
import { LIVE_ENTRY, TraceHistory } from './TraceHistory';

const NO_SCORES: ObserveScoreRow[] = [];

/**
 * One trace's spans in the shared trace viewer (tree or waterfall beside the
 * inspector). Selecting a step inspects it and highlights its canvas node; on
 * the live feed it also jumps to the Logs tab, whose highlight follows.
 */
function SpanTrace({ spans, jumpToLogs }: { spans: SpanEvent[]; jumpToLogs: boolean }) {
  const { setHighlightedNodeId, graph, setDrawerTab } = useAppState();
  const [selectedObsId, setSelectedObsId] = useState<string | null>(null);
  const [mode, setMode] = useState<TraceViewMode>('tree');
  const observations = useMemo(() => spansToObservations(spans), [spans]);
  const now = useNow(spans.some((span) => span.endTime === undefined));

  function handleSelect(obsId: string) {
    setSelectedObsId(obsId);
    const span = spans.find((s) => s.id === obsId);
    setHighlightedNodeId(span ? nodeIdForSpan(graph, span) : undefined);
    if (jumpToLogs) setDrawerTab('logs');
  }

  if (spans.length === 0) {
    return <div className="trace-empty">No spans yet - run the agent to see its steps here.</div>;
  }
  return (
    <TraceViewer
      observations={observations}
      scores={NO_SCORES}
      selectedObsId={selectedObsId}
      onSelect={handleSelect}
      mode={mode}
      onModeChange={setMode}
      now={now}
      // Studio runs reach the observe daemon only when LOUSHO_OBSERVE is set, so the Playground could not load them.
      playgroundLinks={false}
    />
  );
}

/**
 * The Agents drawer's Trace tab: the run's spans in the shared trace viewer
 * (`ui/run/TraceViewer`, the same one `#/traces/:id` uses), driven by
 * `{type:'span'}` WS messages forwarded from the SDK's
 * `TraceExporter.onSpanStart`/`onSpanEnd` hooks (see server/runRegistry.ts's
 * `makeTraceExporter()`) and mapped to observation rows by
 * `spansToObservations`. Selecting a step highlights the corresponding canvas
 * node (`llm`/`tool.call`'s attribute carries the tool name) and jumps the
 * Logs tab's highlight to the same node, via the shared
 * `AppState.highlightedNodeId`.
 *
 * A list on the left holds the agent's persisted traces (the files
 * `lousho traces` reads, served by `GET /agents/:id/traces`); choosing one
 * shows its spans in the same viewer. While a run is active the list
 * starts with "Live", which is the WebSocket feed above. The list reloads
 * when the agent changes and each time a run ends.
 */
export function TracePanel() {
  const { spans, agentId, runStatus } = useAppState();
  const [traces, setTraces] = useState<TraceSummaryPayload[]>([]);
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string>(LIVE_ENTRY);
  const [pastSpans, setPastSpans] = useState<SpanEvent[]>([]);
  const status = runStatus?.status;
  const liveActive = status === 'running' || status === 'paused';

  // A run starts: follow it.
  useEffect(() => {
    if (liveActive) setSelectedId(LIVE_ENTRY);
  }, [liveActive]);

  // Another agent: back to its live view.
  useEffect(() => {
    setSelectedId(LIVE_ENTRY);
    setPastSpans([]);
  }, [agentId]);

  // Load the list for this agent, and again when a run ends.
  useEffect(() => {
    if (liveActive) return;
    let cancelled = false;
    runtimeClient
      .listTraces(agentId)
      .then((list) => {
        if (cancelled) return;
        setTraces(list);
        setListError(undefined);
      })
      .catch((error: unknown) => {
        if (!cancelled) setListError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, liveActive, status]);

  // A past trace is loaded when it is chosen.
  useEffect(() => {
    if (selectedId === LIVE_ENTRY) return;
    let cancelled = false;
    runtimeClient
      .readTrace(agentId, selectedId)
      .then((loaded) => {
        if (!cancelled) setPastSpans(loaded);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPastSpans([]);
        setListError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, selectedId]);

  const showingLive = selectedId === LIVE_ENTRY;
  return (
    <div className="trace-layout">
      <TraceHistory
        traces={traces}
        selectedId={selectedId}
        liveActive={liveActive}
        error={listError}
        onSelect={(id) => {
          setListError(undefined);
          setSelectedId(id);
        }}
      />
      <div className="trace-main">
        <SpanTrace key={selectedId} spans={showingLive ? spans : pastSpans} jumpToLogs={showingLive} />
      </div>
    </div>
  );
}
