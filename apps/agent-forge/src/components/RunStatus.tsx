import { ExternalLink } from 'lucide-react';
import { useAppState } from '../state/AppState';
import { StatusPill } from '../ui/StatusPill';
import type { AgentRunStatusPayload, SpanEvent } from '../../shared/wireTypes';

/**
 * The last run's trace id: the one the server put on the status (its root
 * span's id), else the live feed's root span while that status is in flight.
 */
export function lastRunTraceId(runStatus: AgentRunStatusPayload | undefined, spans: SpanEvent[]): string | undefined {
  if (!runStatus) return undefined;
  return runStatus.traceId ?? spans.find((span) => span.parentId === undefined)?.id;
}

/**
 * Next to Run: the last run's status (idle before any) and, once its trace id
 * is known, an "Open trace" link to `#/traces/<traceId>` - builder runs report
 * to the observe daemon (server/observeReporting.ts), so the trace screen has it.
 * When the wide bar runs short (layout.css's builder-toolbar container rules)
 * the label collapses and the link keeps only its icon; `aria-label` keeps the
 * name "Open trace" and `title` is its tooltip at every width.
 */
export function RunStatus({ showTraceLink = true }: { showTraceLink?: boolean }) {
  const { runStatus, spans } = useAppState();
  const traceId = showTraceLink ? lastRunTraceId(runStatus, spans) : undefined;
  return (
    <>
      <StatusPill status={runStatus?.status ?? 'idle'} live />
      {traceId && (
        <a
          className="run-trace-link"
          href={`#/traces/${encodeURIComponent(traceId)}`}
          aria-label="Open trace"
          title="Open this run's trace"
        >
          <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="run-trace-label">Open trace</span>
        </a>
      )}
    </>
  );
}
