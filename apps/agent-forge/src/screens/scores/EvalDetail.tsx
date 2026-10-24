import { useMemo, type ReactNode } from 'react';
import { ObserveError } from '../../observe/chrome';
import { fmtDateTime, fmtInt, fmtPercent } from '../../observe/format';
import type { ObserveQuery } from '../../observe/useObserve';
import type { ObserveScoreRow } from '../../observe/types';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { TimeSeriesChart } from '../../ui/TimeSeriesChart';
import { groupEvalScores, passRateSeries, scoreStats, traceHref, type CheckGroup, type TrendWindow } from './scoresData';

/** Rows fetched for one eval; a full page means older rows were left out. */
export const EVAL_ROW_LIMIT = 1000;

const fmtMean = (v: number | null) => (v === null ? '-' : v.toFixed(2));

const CHECK_COLUMNS: Column<CheckGroup>[] = [
  { key: 'check', header: 'Check', render: (c) => <span className="scores-name">{c.check}</span> },
  { key: 'pass', header: 'Pass rate', align: 'right', render: (c) => fmtPercent(c.passRate) },
  { key: 'count', header: 'Scores', align: 'right', render: (c) => fmtInt(c.count) },
  { key: 'mean', header: 'Mean', align: 'right', hideBelow: 480, render: (c) => fmtMean(c.mean) },
];

function TraceLink({ row }: { row: ObserveScoreRow }) {
  return (
    <a className="scores-link" href={traceHref(row)} title={row.trace_id}>
      {row.trace_id.slice(0, 10)}
    </a>
  );
}

function Failures({ evalName, rows }: { evalName: string; rows: ObserveScoreRow[] }) {
  if (rows.length === 0) return <p className="scores-muted">No failing scores in this window.</p>;
  return (
    <ul className="scores-failures" aria-label="Latest failures">
      {rows.map((row) => (
        <li key={row.score_id} className="scores-failure">
          <span className="scores-when">{fmtDateTime(row.created_at)}</span>
          <span className="scores-name">{row.name === evalName ? 'eval' : row.name.slice(evalName.length + 1)}</span>
          <span className="scores-value">{row.value === null ? '-' : row.value}</span>
          <TraceLink row={row} />
          <span className="scores-comment">{row.comment}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One expanded eval: its pass-rate trend (from the eval-level row of each
 * case), the per-check pass rates (worst first) and the newest failing rows,
 * each linking to its trace.
 */
export function EvalDetail({
  evalName,
  query,
  window: w,
}: {
  evalName: string;
  query: ObserveQuery<ObserveScoreRow[] | undefined>;
  window: TrendWindow;
}) {
  const rows = query.data;
  const groups = useMemo(() => groupEvalScores(evalName, rows ?? []), [evalName, rows]);
  const runs = scoreStats(groups.evalRows);
  const series = useMemo(() => passRateSeries(groups.evalRows, w), [groups.evalRows, w]);

  let body: ReactNode;
  if (query.error) body = <ObserveError error={query.error} />;
  else if (rows === undefined) body = <div className="scores-muted">Loading {evalName}...</div>;
  else
    body = (
      <>
        <p className="scores-muted" data-eval-runs={runs.count}>
          {fmtInt(runs.count)} runs, {fmtPercent(runs.passRate)} passed
          {rows.length >= EVAL_ROW_LIMIT && ` (newest ${fmtInt(EVAL_ROW_LIMIT)} scores only)`}
        </p>
        <section className="scores-trend" aria-label={`${evalName} pass-rate trend`}>
          <h4 className="scores-subtitle">Pass-rate trend</h4>
          {series.points.length ? (
            <TimeSeriesChart series={[series]} from={w.from} to={w.to} bucketMs={w.bucketMs} yFormat={fmtPercent} height={160} />
          ) : (
            <p className="scores-muted">No eval-level scores in this window.</p>
          )}
        </section>
        <section aria-label={`${evalName} checks`}>
          <h4 className="scores-subtitle">Checks</h4>
          <DataTable
            id="scores-checks"
            columns={CHECK_COLUMNS}
            rows={groups.checks}
            rowKey={(c) => c.name}
            density="compact"
            empty={<EmptyState title="No per-check scores" hint="This eval reported no check rows in the window." />}
          />
        </section>
        <section aria-label={`${evalName} latest failures`}>
          <h4 className="scores-subtitle">Latest failures</h4>
          <Failures evalName={evalName} rows={groups.failures} />
        </section>
      </>
    );
  return (
    <section className="scores-detail" id="scores-detail" aria-label={`Eval ${evalName}`} data-eval={evalName}>
      <h3 className="scores-detail-title">{evalName}</h3>
      {body}
    </section>
  );
}
