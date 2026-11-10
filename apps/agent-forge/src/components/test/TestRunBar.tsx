import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { useAppState } from '../../state/AppState';
import { RunStatus } from '../RunStatus';
import { useRunElapsed } from './useRunElapsed';

/**
 * The Test pane's run bar: the live run's status pill, the provider/model it
 * reported, a ticking elapsed clock while a run is in flight, and - once the
 * status carries a trace id - the same "Open trace" link the Topbar shows.
 * `actions` is the slot later tickets fill (T06's Stop lives here); it sits
 * at the bar's right end.
 */
export function TestRunBar({ actions }: { actions?: ReactNode }) {
  const { runStatus } = useAppState();
  const elapsed = useRunElapsed(runStatus);
  const traceId = runStatus?.traceId;
  return (
    <div className="test-run-bar" role="group" aria-label="Test run">
      <RunStatus showTraceLink={false} />
      {runStatus?.provider && <span className="test-run-model">{runStatus.provider}</span>}
      {elapsed !== undefined && (
        <span className="test-run-elapsed" role="timer" aria-label={`Running for ${elapsed}`}>
          {elapsed}
        </span>
      )}
      {traceId !== undefined && (
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
      {actions !== undefined && <span className="test-run-actions">{actions}</span>}
    </div>
  );
}
