import { fmtCost, fmtDuration, fmtInt, fmtPercent } from '../../observe/format';
import type { ObserveRollupRow } from '../../observe/types';
import { MetricCard } from '../../ui/MetricCard';
import { metricSummary, splitWindow } from './monitoringMetrics';
import type { MonitoringWindow } from './monitoringSeries';

const points = (v: number) => `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })} pp`;

/**
 * The four KPI cards over the chart window: runs, error rate, p95 latency and
 * cost, each with its per-bucket sparkline and the change against the
 * previous window (`rows` reach back one window before `from`).
 */
export function MetricRow({
  rows,
  from,
  win,
  loading,
}: {
  rows: ObserveRollupRow[];
  from: number;
  win: MonitoringWindow;
  loading: boolean;
}) {
  const { current, previous } = splitWindow(rows, from);
  const m = metricSummary(current, previous);
  const label = `vs previous ${win}`;
  const delta = (value: number | undefined, goodWhen: 'up' | 'down', format?: (v: number) => string) =>
    value === undefined ? undefined : { value, goodWhen, label, format };
  // The delta's label is spoken only; this is its visible (and screen-reader silent) counterpart.
  const vs = (value: number | undefined) =>
    value === undefined ? undefined : <span aria-hidden="true">vs prev. {win}</span>;
  return (
    <div className="mon-metrics">
      <MetricCard
        label="Runs"
        value={fmtInt(m.runs.value)}
        delta={delta(m.runs.delta, 'up')}
        hint={vs(m.runs.delta)}
        sparkline={m.runs.sparkline}
        loading={loading}
      />
      <MetricCard
        label="Error rate"
        value={fmtPercent(m.errorRate.value)}
        delta={delta(m.errorRate.delta, 'down', points)}
        hint={vs(m.errorRate.delta)}
        sparkline={m.errorRate.sparkline}
        loading={loading}
      />
      {/* One line of meta per card: the weighting goes in a tooltip once a delta takes the line. */}
      <div className="mon-metric" title="Runs-weighted mean of the per-agent p95s">
        <MetricCard
          label="p95 latency"
          value={fmtDuration(m.p95.value)}
          delta={delta(m.p95.delta, 'down')}
          hint={m.p95.delta === undefined ? 'runs-weighted' : vs(m.p95.delta)}
          sparkline={m.p95.sparkline}
          loading={loading}
        />
      </div>
      <MetricCard
        label="Cost"
        value={fmtCost(m.cost.value)}
        delta={delta(m.cost.delta, 'down')}
        hint={vs(m.cost.delta)}
        sparkline={m.cost.sparkline}
        loading={loading}
      />
    </div>
  );
}
