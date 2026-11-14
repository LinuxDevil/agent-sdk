import { useCallback, useMemo, useState } from 'react';
import { CircleAlert, Info, Play, RefreshCw, Sparkles } from 'lucide-react';

import { agentTabPath } from '../../agents/agentTabs';
import { fmtCost, fmtDuration, fmtInt, fmtStarted } from '../../../observe/format';
import { navigate } from '../../../router/router';
import { Card } from '../../../ui/Card';
import { DataTable, type Column } from '../../../ui/DataTable';
import { EmptyState } from '../../../ui/EmptyState';
import { RatingControl } from '../../../ui/RatingControl';
import { StatusBadge } from '../../../ui/StatusBadge';
import { statusKey } from '../../../ui/status';
import { useAgentDetail } from '../AgentDetailContext';
import { errorMessage } from '../../../components/errorMessage';
import { useSuggestFix } from '../../../state/useSuggestFix';
import { useToast } from '../../../ui/Toast';
import type { RunRow } from './runsModel';
import { useAgentRuns } from './useAgentRuns';
import './runs.css';

/** The Runs tab's columns, in order (PLAN §11: status, run, started, duration, tokens, cost, rating, open). */
const columnsFor = (
  agentId: string,
  onRated: () => void,
  suggest: { canSuggest: boolean; pendingTraceId: string | null; onSuggestFix(traceId: string): void }
): Column<RunRow>[] => [
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
    width: 150,
    render: (r) => (
      <RatingControl agentId={agentId} traceId={r.traceId} value={r.rating} size="sm" onRated={onRated} />
    ),
  },
  {
    key: 'open',
    header: <span className="visually-hidden">Open</span>,
    align: 'right',
    width: 200,
    render: (r) => (
      <span className="runs-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!suggest.canSuggest || suggest.pendingTraceId !== null}
          title={
            !suggest.canSuggest
              ? 'Suggestions need inline instructions'
              : suggest.pendingTraceId !== null
                ? 'Suggesting…'
                : undefined
          }
          onClick={() => suggest.onSuggestFix(r.traceId)}
        >
          <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
          Suggest a fix
        </button>
        <a
          className="btn btn-ghost btn-sm"
          href={`#/traces/${encodeURIComponent(r.traceId)}`}
          aria-label={`Open trace ${r.traceId}`}
        >
          Open trace
        </a>
      </span>
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
  const toast = useToast();
  const suggestFix = useSuggestFix();
  const [pendingTraceId, setPendingTraceId] = useState<string | null>(null);
  // The pass only edits inline instructions - a `{ file }` ref disables the button.
  const canSuggest = typeof record.spec.instructions === 'string';
  const onSuggestFix = useCallback(
    (traceId: string) => {
      setPendingTraceId(traceId);
      suggestFix(record.id, traceId).catch((cause: unknown) => {
        toast.show({ message: errorMessage(cause), tone: 'error' });
        setPendingTraceId(null);
      });
    },
    [record.id, suggestFix, toast]
  );
  const columns = useMemo(
    () => columnsFor(record.id, refresh, { canSuggest, pendingTraceId, onSuggestFix }),
    [record.id, refresh, canSuggest, pendingTraceId, onSuggestFix]
  );

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
            columns={columns}
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
