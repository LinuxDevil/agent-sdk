import type { TraceSummaryPayload } from '../../../shared/wireTypes';

/** The list entry that stands for the run in progress. */
export const LIVE_ENTRY = 'live';

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function formatCost(costUsd: number | undefined): string {
  return costUsd === undefined ? '-' : `$${costUsd.toFixed(costUsd < 0.01 ? 6 : 4)}`;
}

/** One line per persisted run: when, how long, model calls, tokens in/out, cost and status. */
export function TraceHistory({
  traces,
  selectedId,
  liveActive,
  error,
  onSelect,
}: {
  traces: TraceSummaryPayload[];
  /** `LIVE_ENTRY` or a trace id. */
  selectedId: string;
  /** A run is in progress: the list starts with a "Live" entry. */
  liveActive: boolean;
  error?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="trace-history" role="listbox" aria-label="Trace history">
      {liveActive && (
        <button
          role="option"
          aria-selected={selectedId === LIVE_ENTRY}
          className={`trace-item trace-item-live${selectedId === LIVE_ENTRY ? ' selected' : ''}`}
          onClick={() => onSelect(LIVE_ENTRY)}
        >
          <b>Live</b>
          <span className="trace-item-meta">running now</span>
        </button>
      )}
      {error && <div className="trace-history-note trace-history-error">{error}</div>}
      {!error && traces.length === 0 && !liveActive && (
        <div className="trace-history-note">No saved traces yet. Each run is saved under .lousho/agents/&lt;agent&gt;/traces.</div>
      )}
      {traces.map((trace) => (
        <button
          key={trace.traceId}
          role="option"
          aria-selected={selectedId === trace.traceId}
          className={`trace-item${trace.status === 'error' ? ' trace-item-error' : ''}${selectedId === trace.traceId ? ' selected' : ''}`}
          onClick={() => onSelect(trace.traceId)}
          title={trace.traceId}
        >
          <span className="trace-item-head">
            <span>{new Date(trace.startTime).toLocaleString()}</span>
            <span className="trace-item-status">{trace.status}</span>
          </span>
          <span className="trace-item-meta">
            {formatDuration(trace.durationMs)} · {trace.modelCalls} model · {trace.inputTokens}/{trace.outputTokens} tokens ·{' '}
            {formatCost(trace.costUsd)}
          </span>
        </button>
      ))}
    </div>
  );
}
