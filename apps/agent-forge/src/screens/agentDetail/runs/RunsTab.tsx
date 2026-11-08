import { CircleAlert, Info, Play, RefreshCw, Star } from 'lucide-react';

import { agentTabPath } from '../../agents/agentTabs';
import { fmtCost, fmtDuration, fmtInt, fmtStarted } from '../../../observe/format';
import { navigate } from '../../../router/router';
import { Card } from '../../../ui/Card';
import { DataTable, type Column } from '../../../ui/DataTable';
import { EmptyState } from '../../../ui/EmptyState';
import { StatusBadge } from '../../../ui/StatusBadge';
import { statusKey } from '../../../ui/status';
import { useAgentDetail } from '../AgentDetailContext';
import type { RunRow } from './runsModel';
import { useAgentRuns } from './useAgentRuns';
import './runs.css';

/** The rating cell: "—" when unrated, else a star and the 1-5 value (danger at ≤ 2, comment as tooltip). */
function RatingCell({ rating, ratingComment }: Pick<RunRow, 'rating' | 'ratingComment'>): JSX.Element {
  if (rating == null) return <span className="value-missing">—</span>;
  return (
    <span
      className={rating <= 2 ? 'runs-rating runs-rating-low' : 'runs-rating'}
      aria-label={`Rated ${rating} out of 5`}
      title={ratingComment ?? undefined}
    >
      <Star size={12} aria-hidden="true" />
      <span aria-hidden="true">{rating}</span>
    </span>
  );
}

/** The Runs tab's columns, in order (PLAN §11: status, run, started, duration, tokens, cost, rating, open). */
const COLUMNS: Column<RunRow>[] = [
  {
    key: 'status',
    header: 'Status',
    width: 96,
    render: (r) => <StatusBadge status={statusKey(r.status)} size="sm" />,
  },
  {
    key: 'name',
    header: 'Run',
    minWidth: 220,
    render: (r) => (
      <>
        <span className="runs-name">{r.name}</span>
        <span className="runs-id">{r.traceId}</span>
      </>
    ),
  },
  { key: 'start', header: 'Started', width: 140, render: (r) => fmtStarted(r.startTime) },
  {
    key: 'duration',
    header: 'Duration',
    align: 'right',
    width: 96,
    hideBelow: 640,
    render: (r) => fmtDuration(r.durationMs),
  },
  {
    key: 'tokens',
    header: 'Tokens',
    align: 'right',
    width: 96,
    hideBelow: 720,
    render: (r) => fmtInt(r.inputTokens + r.outputTokens),
  },
  {
    key: 'cost',
    header: 'Cost',
    align: 'right',
    width: 88,
    hideBelow: 720,
    render: (r) => (r.costUsd == null ? '—' : fmtCost(r.costUsd)),
  },
  {
    key: 'rating',
    header: 'Rating',
    align: 'right',
    width: 88,
    render: (r) => <RatingCell rating={r.rating} ratingComment={r.ratingComment} />,
  },
  {
    key: 'open',
    header: <span className="visually-hidden">Open</span>,
    align: 'right',
    width: 112,
    render: (r) => (
      <a
        className="btn btn-ghost btn-sm"
        href={`#/traces/${encodeURIComponent(r.traceId)}`}
        aria-label={`Open trace ${r.traceId}`}
      >
        Open trace
      </a>
    ),
  },
];

/**
 * The Runs tab (A11, PLAN §11): this agent's runs newest first in a
 * DataTable, each row opening its trace (`#/traces/:id`), with the human
 * `rating` column joined from the observe daemon - which degrades to "—"
 * plus a note when the daemon is down.
 */
export function RunsTab(): JSX.Element {
  const { record } = useAgentDetail();
  const { rows, loading, error, ratingsUnavailable, refresh } = useAgentRuns(record.id);
  const testPaneHref = `#${agentTabPath(record.id, 'canvas')}?test=1`;

  return (
    <div className="runs-tab">
      <div className="runs-toolbar">
        <p className="runs-count">{`${rows?.length ?? 0} runs`}</p>
        <button type="button" className="btn btn-sm" onClick={refresh}>
          <RefreshCw size={14} aria-hidden="true" />
          Refresh
        </button>
      </div>
      {ratingsUnavailable && (
        <p className="runs-note" role="status">
          <Info size={14} aria-hidden="true" />
          Ratings need the observe daemon (lousho observe). Runs still show.
        </p>
      )}
      {error !== undefined ? (
        <Card>
          <EmptyState
            icon={CircleAlert}
            title="Could not load runs"
            hint={error}
            action={
              <button type="button" className="btn" onClick={refresh}>
                Retry
              </button>
            }
          />
        </Card>
      ) : (
        <Card padding="none">
          <DataTable
            id="agent-runs"
            columns={COLUMNS}
            rows={rows ?? []}
            rowKey={(r) => r.traceId}
            onRowOpen={(r) => navigate(`/traces/${r.traceId}`)}
            loading={loading}
            density="compact"
            empty={
              <EmptyState
                icon={Play}
                title="No runs yet"
                hint="Run it from the Test pane."
                action={
                  <a className="btn btn-primary btn-sm" href={testPaneHref}>
                    Open the Test pane
                  </a>
                }
              />
            }
          />
        </Card>
      )}
    </div>
  );
}
