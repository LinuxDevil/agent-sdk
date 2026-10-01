import { useMemo, useState } from 'react';
import { useAppState } from '../../state/AppState';
import { orderSpansForWaterfall } from '../../state/spanReducer';
import type { SpanEvent } from '../../../shared/wireTypes';
import type { AgentGraphSpec } from '../../graph/types';
import { findLlmNodeId, findToolNodeId } from './nodeLookup';

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
  return (
    <div className={`trace-row${selected ? ' selected' : ''}`} onClick={onSelect} title={JSON.stringify(span.attributes)}>
      <span className="trace-name">{span.name}</span>
      <span className="trace-bar-track">
        <span className={`trace-bar${running ? ' pending' : ''}`} style={{ left: `${startPct}%`, width: `${widthPct}%` }} />
      </span>
      <span className="trace-dur">{running ? 'running' : `${durationMs}ms`}</span>
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
 */
export function TracePanel() {
  const { spans, highlightedNodeId, setHighlightedNodeId, graph, setDrawerTab } = useAppState();
  const [selectedSpanId, setSelectedSpanId] = useState<string | undefined>(undefined);

  const ordered = useMemo(() => orderSpansForWaterfall(spans), [spans]);
  const { minStart, maxEnd } = useMemo(() => timeBounds(ordered), [ordered]);
  const totalMs = Math.max(1, maxEnd - minStart);

  function handleSelect(span: SpanEvent) {
    setSelectedSpanId(span.id);
    setHighlightedNodeId(nodeIdForSpan(graph, span));
    setDrawerTab('logs');
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
