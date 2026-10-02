import { useEffect, useMemo, useState } from 'react';
import { useAppState } from '../../state/AppState';
import { orderSpansForWaterfall } from '../../state/spanReducer';
import type { SpanEvent, TraceSummaryPayload } from '../../../shared/wireTypes';
import type { AgentGraphSpec } from '../../graph/types';
import { runtimeClient } from '../../runtime/runtimeClient';
import { errorMessage } from '../errorMessage';
import { findLlmNodeId, findToolNodeId } from './nodeLookup';
import { LIVE_ENTRY, TraceHistory } from './TraceHistory';

function nodeIdForSpan(graph: AgentGraphSpec, span: SpanEvent): string | undefined {
  // SDK spans follow the OpenTelemetry GenAI conventions (LOU-D9): the operation is
  // `chat` (model call) or `execute_tool` (tool call).
  const operation = span.attributes['gen_ai.operation.name'];
  if (operation === 'chat') return findLlmNodeId(graph);
  if (operation === 'execute_tool') {
    return findToolNodeId(graph, span.attributes['gen_ai.tool.name'] as string | undefined);
  }
  return undefined;
}

function timeBounds(spans: SpanEvent[]): { minStart: number; maxEnd: number } {
  if (spans.length === 0) return { minStart: 0, maxEnd: 1 };
  const starts = spans.map((s) => s.startTime);
  const ends = spans.map((s) => s.endTime ?? Date.now());
  return { minStart: Math.min(...starts), maxEnd: Math.max(...ends) };
}

function spanGeometry(span: SpanEvent, minStart: number, totalMs: number) {
  const startPct = ((span.startTime - minStart) / totalMs) * 100;
  const durationMs = (span.endTime ?? Date.now()) - span.startTime;
  const widthPct = Math.max(0.5, (durationMs / totalMs) * 100);
  return { startPct, durationMs, widthPct };
}

function SpanRow({
  span,
  minStart,
  totalMs,
  selected,
  onSelect,
}: {
  span: SpanEvent;
  minStart: number;
  totalMs: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { startPct, durationMs, widthPct } = spanGeometry(span, minStart, totalMs);
  const running = span.endTime === undefined;
  const failed = span.status?.code === 'error';
  const attributes = JSON.stringify(span.attributes);
  return (
    <div
      className={`trace-row${selected ? ' selected' : ''}${failed ? ' trace-row-error' : ''}`}
      onClick={onSelect}
      title={failed && span.status?.message ? `${span.status.message}\n${attributes}` : attributes}
    >
      <span className="trace-name">{span.name}</span>
      {span.kind && <span className="trace-kind">{span.kind}</span>}
      <span className="trace-bar-track">
        <span
          className={`trace-bar${running ? ' pending' : ''}${failed ? ' error' : ''}`}
          style={{ left: `${startPct}%`, width: `${widthPct}%` }}
        />
      </span>
      <span className="trace-dur">{failed ? 'error' : running ? 'running' : `${durationMs}ms`}</span>
    </div>
  );
}

/** The waterfall of one trace's spans; clicking a span highlights its canvas node. */
function Waterfall({ spans, jumpToLogs }: { spans: SpanEvent[]; jumpToLogs: boolean }) {
  const { highlightedNodeId, setHighlightedNodeId, graph, setDrawerTab } = useAppState();
  const [selectedSpanId, setSelectedSpanId] = useState<string | undefined>(undefined);

  const ordered = useMemo(() => orderSpansForWaterfall(spans), [spans]);
  const { minStart, maxEnd } = useMemo(() => timeBounds(ordered), [ordered]);
  const totalMs = Math.max(1, maxEnd - minStart);

  function handleSelect(span: SpanEvent) {
    setSelectedSpanId(span.id);
    setHighlightedNodeId(nodeIdForSpan(graph, span));
    if (jumpToLogs) setDrawerTab('logs');
  }

  if (ordered.length === 0) {
    return <div className="trace-empty">No spans yet - run the agent to see its span waterfall here.</div>;
  }

  return (
    <div className="trace-panel">
      {ordered.map((span) => {
        const nodeId = nodeIdForSpan(graph, span);
        return (
          <SpanRow
            key={span.id}
            span={span}
            minStart={minStart}
            totalMs={totalMs}
            selected={span.id === selectedSpanId || (!!nodeId && nodeId === highlightedNodeId)}
            onSelect={() => handleSelect(span)}
          />
        );
      })}
    </div>
  );
}

/**
 * O2: real span waterfall, driven by `{type:'span'}` WS messages forwarded
 * from the SDK's `TraceExporter.onSpanStart`/`onSpanEnd` hooks (see
 * server/runRegistry.ts's `makeTraceExporter()`) - bar position/width are
 * real `Date.now()` timestamps, not synthetic ones. Clicking a span
 * highlights the corresponding canvas node (`llm`/`tool.call`'s attribute
 * carries the tool name) and jumps the Logs tab's highlight to the same
 * node, via the shared `AppState.highlightedNodeId`.
 *
 * M5b: a list on the left holds the agent's persisted traces (the files
 * `lousho traces` reads, served by `GET /agents/:id/traces`); choosing one
 * shows its spans in the same waterfall. While a run is active the list
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
        <Waterfall key={selectedId} spans={showingLive ? spans : pastSpans} jumpToLogs={showingLive} />
      </div>
    </div>
  );
}
