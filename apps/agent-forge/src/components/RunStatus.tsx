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
 */
export function RunStatus({ showTraceLink = true }: { showTraceLink?: boolean }) {
  const { runStatus, spans } = useAppState();
  const traceId = showTraceLink ? lastRunTraceId(runStatus, spans) : undefined;
  return (
    <>
      <StatusPill status={runStatus?.status ?? 'idle'} live />
      {traceId && (
        <a className="run-trace-link" href={`#/traces/${encodeURIComponent(traceId)}`} title="Open this run's trace">
          Open trace
        </a>
      )}
    </>
  );
}
