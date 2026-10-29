import { useMemo, type ReactNode } from 'react';
import { ArrowUpRight, CircleCheck, ListChecks } from 'lucide-react';
import { ObserveError } from '../../observe/chrome';
import { fmtDateTime, fmtInt, fmtPercent } from '../../observe/format';
import type { ObserveQuery } from '../../observe/useObserve';
import type { ObserveScoreRow } from '../../observe/types';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import { TimeSeriesChart } from '../../ui/TimeSeriesChart';
import { groupEvalScores, passRateSeries, scoreStats, traceHref, type CheckGroup, type TrendWindow } from './scoresData';
import '../../ui/card.css';

/** Rows fetched for one eval; a full page means older rows were left out. */
export const EVAL_ROW_LIMIT = 1000;

const fmtMean = (v: number | null) => (v === null ? '-' : v.toFixed(2));

/**
 * A pass rate as a two-tone bar (passed in success, failed in the danger tint)
 * plus its tabular figure; no rate shows '-'.
 */
export function PassRateBar({ rate }: { rate: number | null }) {
  const width = rate === null ? 0 : Math.max(0, Math.min(1, rate)) * 100;
  return (
    <span className="score-rate">
      <span className="score-rate-bar" data-empty={rate === null ? 'true' : undefined} aria-hidden="true">
        <span className="score-rate-fill" style={{ width: `${width}%` }} />
      </span>
      <span className="score-rate-value">{fmtPercent(rate)}</span>
    </span>
  );
}

const CHECK_COLUMNS: Column<CheckGroup>[] = [
  { key: 'check', header: 'Check', render: (c) => <span className="scores-name" title={c.check}>{c.check}</span> },
  { key: 'pass', header: 'Pass rate', align: 'right', width: 170, render: (c) => <PassRateBar rate={c.passRate} /> },
  { key: 'count', header: 'Scores', align: 'right', width: 80, render: (c) => fmtInt(c.count) },
  { key: 'mean', header: 'Mean', align: 'right', width: 72, hideBelow: 480, render: (c) => fmtMean(c.mean) },
];

function TraceLink({ row }: { row: ObserveScoreRow }) {
  return (
    <a className="evals-trace-link" href={traceHref(row)} title={`Open trace ${row.trace_id}`}>
      {row.trace_id.slice(0, 10)}
      <ArrowUpRight size={12} strokeWidth={1.75} aria-hidden="true" />
    </a>
  );
}

function Failures({ evalName, rows }: { evalName: string; rows: ObserveScoreRow[] }) {
  if (rows.length === 0)
    return (
      <p className="scores-none">
        <CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" />
        No failing scores in this window.
      </p>
    );
  return (
    <ul className="scores-failures" aria-label="Latest failures">
      {rows.map((row) => (
        <li key={row.score_id} className="scores-failure">
          <div className="scores-failure-head">
            <span className="status-pill pill-error scores-value" title="Failed score value">
              <span className="dot" aria-hidden="true" />
              {row.value === null ? '-' : row.value}
            </span>
            <span className="scores-name">{row.name === evalName ? 'eval' : row.name.slice(evalName.length + 1)}</span>
            <span className="scores-when">{fmtDateTime(row.created_at)}</span>
            <TraceLink row={row} />
          </div>
          {row.comment && <p className="scores-comment">{row.comment}</p>}
        </li>
      ))}
    </ul>
  );
}

/** The detail body while the eval's rows load: chart and list placeholders. */
function DetailLoading({ evalName }: { evalName: string }) {
  return (
    <div className="scores-detail-loading">
      <p className="scores-muted" role="status">
        Loading {evalName}...
      </p>
      <Skeleton width="100%" height={160} radius="var(--radius)" />
      <div className="scores-detail-grid">
        <Skeleton width="100%" height={96} radius="var(--radius)" />
        <Skeleton width="100%" height={96} radius="var(--radius)" />
      </div>
    </div>
  );
}

function DetailBody({ evalName, rows, w }: { evalName: string; rows: ObserveScoreRow[]; w: TrendWindow }) {
  const groups = useMemo(() => groupEvalScores(evalName, rows), [evalName, rows]);
  const series = useMemo(() => passRateSeries(groups.evalRows, w), [groups.evalRows, w]);
  return (
    <>
      <section className="scores-section" aria-label={`${evalName} pass-rate trend`}>
        <h3 className="scores-subtitle">Pass-rate trend</h3>
        {series.points.length ? (
          <TimeSeriesChart series={[series]} from={w.from} to={w.to} bucketMs={w.bucketMs} yFormat={fmtPercent} height={160} />
        ) : (
          <p className="scores-muted">No eval-level scores in this window.</p>
        )}
      </section>
      <div className="scores-detail-grid">
        <section className="scores-section" aria-label={`${evalName} checks`}>
          <h3 className="scores-subtitle">Checks</h3>
          <div className="scores-panel">
            <DataTable
              id="scores-checks"
              columns={CHECK_COLUMNS}
              rows={groups.checks}
              rowKey={(c) => c.name}
              density="compact"
              empty={<EmptyState icon={ListChecks} title="No per-check scores" hint="This eval reported no check rows in the window." />}
            />
          </div>
        </section>
        <section className="scores-section" aria-label={`${evalName} latest failures`}>
          <h3 className="scores-subtitle">Latest failures</h3>
          <Failures evalName={evalName} rows={groups.failures} />
        </section>
      </div>
    </>
  );
}

/** "2 runs · Run pass rate 50.0%" under the eval's name, from its eval-level rows. */
function RunsLine({ evalName, rows }: { evalName: string; rows: ObserveScoreRow[] }) {
  const runs = scoreStats(groupEvalScores(evalName, rows).evalRows);
  return (
    <p className="card-description" data-eval-runs={runs.count}>
      {fmtInt(runs.count)} runs · Run pass rate {fmtPercent(runs.passRate)}
      {rows.length >= EVAL_ROW_LIMIT && ` (newest ${fmtInt(EVAL_ROW_LIMIT)} scores only)`}
    </p>
  );
}

/**
 * One expanded eval, as a card: its run count and run pass rate, the pass-rate
 * trend (from the eval-level row of each case), then the per-check pass rates
 * (worst first) beside the newest failing rows, each linking to its trace.
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
  let body: ReactNode;
  if (query.error) body = <ObserveError error={query.error} />;
  else if (rows === undefined) body = <DetailLoading evalName={evalName} />;
  else body = <DetailBody evalName={evalName} rows={rows} w={w} />;
  return (
    <section className="card card-pad-md scores-detail" id="scores-detail" aria-label={`Eval ${evalName}`} data-eval={evalName}>
      <div className="card-header">
        <div className="card-heading">
          <h2 className="card-title scores-detail-title">{evalName}</h2>
          {rows !== undefined && !query.error && <RunsLine evalName={evalName} rows={rows} />}
        </div>
      </div>
      <div className="card-body scores-detail-body">{body}</div>
    </section>
  );
}
