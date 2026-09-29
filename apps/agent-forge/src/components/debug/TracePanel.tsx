import { useMemo, useState } from 'react';
import { useAppState } from '../../state/AppState';
import { orderSpansForWaterfall } from '../../state/spanReducer';
import type { SpanEvent } from '../../runtime/runtimeClient';

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

  const { minStart, maxEnd } = useMemo(() => {
    if (ordered.length === 0) return { minStart: 0, maxEnd: 1 };
    const starts = ordered.map((s) => s.startTime);
    const ends = ordered.map((s) => s.endTime ?? Date.now());
    return { minStart: Math.min(...starts), maxEnd: Math.max(...ends) };
  }, [ordered]);

  const totalMs = Math.max(1, maxEnd - minStart);

  function nodeIdForSpan(span: SpanEvent): string | undefined {
    if (span.name === 'llm.generate') return graph.nodes.find((n) => n.type === 'llm')?.id;
    if (span.name === 'tool.call') {
      const toolName = span.attributes.toolName as string | undefined;
      if (toolName) return graph.nodes.find((n) => n.type === 'tool' && n.data.toolName === toolName)?.id;
    }
    return undefined;
  }

  function handleSelect(span: SpanEvent) {
    setSelectedSpanId(span.id);
    setHighlightedNodeId(nodeIdForSpan(span));
  }

  if (ordered.length === 0) {
    return <div className="trace-empty">No spans yet - run the agent to see its span waterfall here.</div>;
  }

  return (
    <div className="trace-panel">
      {ordered.map((span) => {
        const startPct = ((span.startTime - minStart) / totalMs) * 100;
        const durationMs = (span.endTime ?? Date.now()) - span.startTime;
        const widthPct = Math.max(0.5, (durationMs / totalMs) * 100);
        const nodeId = nodeIdForSpan(span);
        const isHighlighted = nodeId && nodeId === highlightedNodeId;
        return (
          <div
            key={span.id}
            className={`trace-row${span.id === selectedSpanId || isHighlighted ? ' selected' : ''}`}
            onClick={() => {
              handleSelect(span);
              setDrawerTab('logs');
            }}
            title={JSON.stringify(span.attributes)}
          >
            <span className="trace-name">{span.name}</span>
            <span className="trace-bar-track">
              <span
                className={`trace-bar${span.endTime === undefined ? ' pending' : ''}`}
                style={{ left: `${startPct}%`, width: `${widthPct}%` }}
              />
            </span>
            <span className="trace-dur">{span.endTime === undefined ? 'running' : `${durationMs}ms`}</span>
          </div>
        );
      })}
    </div>
  );
}
