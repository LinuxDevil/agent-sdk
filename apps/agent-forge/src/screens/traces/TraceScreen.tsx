import { useCallback, useMemo, useState } from 'react';
import { ArrowLeft, FileQuestion } from 'lucide-react';

import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { nestObservations } from '../../observe/tree';
import type { ObserveObservationRow } from '../../observe/types';
import { useAgents, useDaemonDown, useDaemonHealth, useTraceDetail } from '../../observe/useObserve';
import { navigate } from '../../router/router';
import { useQueryState } from '../../router/useRoute';
import { ScreenHeader } from '../../shell/ScreenHeader';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton';
import { tracesListPath } from './tracesUrl';
import { TraceViewer, type TraceViewMode } from '../../ui/run/TraceViewer';
import { isRunning } from '../../ui/run/rows';
import { useNow } from '../../ui/run/useNow';
import { TraceFeedback } from './TraceFeedback';
import { TraceHeader } from './TraceHeader';
// The shared daemon-down / error presentation is styled there.
import '../../observe/observe.css';
// The loading header card is the kit's .card / HeaderCard look.
import '../../ui/card.css';
import '../../ui/headerCard.css';
import './trace.css';

const DEFAULT_POLL_MS = 5000;

const parseObs = (s: string | null): string | null => (s === null || s === '' ? null : s);
const formatObs = (v: string | null): string | null => v;

function rootOf(rows: ObserveObservationRow[]): ObserveObservationRow | undefined {
  return nestObservations(rows)[0]?.row;
}

function MissingTrace({ traceId }: { traceId: string }) {
  return (
    <EmptyState
      icon={FileQuestion}
      title="Trace not found"
      hint={`No trace '${traceId}'. Eval traces can be missing if the run's reporter never flushed.`}
      action={
        <button type="button" className="btn" onClick={() => navigate(tracesListPath())}>
          Back to traces
        </button>
      }
    />
  );
}

/** The first load: the header card and the two panes as skeletons, announced once as "Loading trace". */
function TraceLoading() {
  return (
    <div className="trace-loading" role="status">
      <span className="visually-hidden">Loading trace...</span>
      <div className="card header-card trace-header-skeleton" aria-hidden="true">
        <Skeleton width={120} height={12} />
        <Skeleton width={260} height={20} />
        <div className="trace-skeleton-chips">
          {[88, 96, 80, 132, 150].map((w) => (
            <Skeleton key={w} width={w} height={24} radius="var(--radius-full)" />
          ))}
        </div>
      </div>
      <div className="run-viewer" aria-hidden="true">
        <div className="run-viewer-steps trace-skeleton-pane">
          <SkeletonRows rows={8} />
        </div>
        <div className="run-viewer-inspector trace-skeleton-pane">
          <SkeletonRows rows={5} />
        </div>
      </div>
    </div>
  );
}

/** The trace plus everything derived from it; while the daemon is down it re-polls so the screen recovers in place. */
function useTrace(traceId: string, pollMs: number) {
  const health = useDaemonHealth(pollMs);
  // A health flip back to "up" re-fetches the trace at once.
  const detail = useTraceDetail(traceId, health.down);
  const agents = useAgents(undefined, health.down);
  const down = useDaemonDown(health.down, [detail], pollMs);

  const observations = detail.data?.observations;
  const root = useMemo(() => (observations ? rootOf(observations) : undefined), [observations]);
  const now = useNow(root !== undefined && isRunning(root));
  const agentName = agents.data?.find((a) => a.agent_id === root?.agent_id)?.name ?? undefined;
  return { detail, down, root, now, agentName };
}

/**
 * `#/traces/:traceId` - one trace: the page header (Traces, the trace id, a
 * link back to the list with its last filters), then a header card (root
 * name, status, actions, agent, model, timing, tokens, cost, session) over
 * the unified trace viewer.
 * `?obs=<id>` is the selected step, read on load and written with replace on
 * every selection; the inspector's Feedback section takes thumbs up/down
 * scores. A dead daemon shows the shared daemon-down state without touching
 * the URL and the screen re-fetches by itself once the daemon is back.
 */
export function TraceScreen({ traceId, pollMs = DEFAULT_POLL_MS }: { traceId: string; pollMs?: number }) {
  const { detail, down, root, now, agentName } = useTrace(traceId, pollMs);
  const [obsId, setObsId] = useQueryState('obs', parseObs, formatObs);
  const [mode, setMode] = useState<TraceViewMode>('tree');

  const refresh = detail.refresh;
  const renderFeedback = useCallback(
    (row: ObserveObservationRow) => <TraceFeedback key={row.obs_id} observation={row} onSaved={refresh} />,
    [refresh],
  );

  let body: React.ReactNode;
  if (down) body = <ObserveDaemonDown />;
  else if (detail.error) body = <ObserveError error={detail.error} />;
  else if (detail.data === undefined && detail.loading) body = <TraceLoading />;
  else if (detail.data === undefined) body = <MissingTrace traceId={traceId} />;
  else
    body = (
      <>
        {root && (
          <TraceHeader root={root} observations={detail.data.observations} agentName={agentName} now={now} selectedObsId={obsId} />
        )}
        <TraceViewer
          observations={detail.data.observations}
          scores={detail.data.scores}
          selectedObsId={obsId}
          onSelect={setObsId}
          mode={mode}
          onModeChange={setMode}
          now={now}
          renderFeedback={renderFeedback}
          /* The header card's "Open in Playground" and the tree row's icon link already cover the selected step. */
          inspectorPlaygroundLink={false}
        />
      </>
    );
  return (
    <div className="trace-screen" data-trace-id={traceId}>
      <ScreenHeader
        title="Traces"
        status={null}
        description={
          <>
            Trace <code className="trace-id">{traceId}</code>
          </>
        }
        actions={
          <a className="btn btn-ghost trace-back" href={`#${tracesListPath()}`}>
            <ArrowLeft aria-hidden="true" />
            All traces
          </a>
        }
      />
      {body}
    </div>
  );
}
