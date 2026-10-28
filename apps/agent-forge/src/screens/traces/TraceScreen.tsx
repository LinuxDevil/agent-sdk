import { useCallback, useMemo, useState } from 'react';

import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { nestObservations } from '../../observe/tree';
import type { ObserveObservationRow } from '../../observe/types';
import { useAgents, useDaemonDown, useDaemonHealth, useTraceDetail } from '../../observe/useObserve';
import { navigate } from '../../router/router';
import { useQueryState } from '../../router/useRoute';
import { EmptyState } from '../../ui/EmptyState';
import { tracesListPath } from './tracesUrl';
import { TraceViewer, type TraceViewMode } from '../../ui/run/TraceViewer';
import { useNow } from '../../ui/run/useNow';
import { TraceFeedback } from './TraceFeedback';
import { TraceHeader } from './TraceHeader';
// The shared daemon-down / error presentation is styled there.
import '../../observe/observe.css';
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

/** The trace plus everything derived from it; while the daemon is down it re-polls so the screen recovers in place. */
function useTrace(traceId: string, pollMs: number) {
  const health = useDaemonHealth(pollMs);
  // A health flip back to "up" re-fetches the trace at once.
  const detail = useTraceDetail(traceId, health.down);
  const agents = useAgents(undefined, health.down);
  const down = useDaemonDown(health.down, [detail], pollMs);

  const observations = detail.data?.observations;
  const root = useMemo(() => (observations ? rootOf(observations) : undefined), [observations]);
  const now = useNow(root?.end === null);
  const agentName = agents.data?.find((a) => a.agent_id === root?.agent_id)?.name ?? undefined;
  return { detail, down, root, now, agentName };
}

/**
 * `#/traces/:traceId` - one trace: a header (root name, status, agent, model,
 * timing, tokens, cost, session, copy link) over the unified trace viewer.
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
  else if (detail.data === undefined && detail.loading) body = <div className="trace-loading">Loading trace...</div>;
  else if (detail.data === undefined) body = <MissingTrace traceId={traceId} />;
  else
    body = (
      <>
        {root && <TraceHeader root={root} observations={detail.data.observations} agentName={agentName} now={now} />}
        <TraceViewer
          observations={detail.data.observations}
          scores={detail.data.scores}
          selectedObsId={obsId}
          onSelect={setObsId}
          mode={mode}
          onModeChange={setMode}
          now={now}
          renderFeedback={renderFeedback}
        />
      </>
    );
  return (
    <div className="trace-screen" data-trace-id={traceId}>
      {body}
    </div>
  );
}
