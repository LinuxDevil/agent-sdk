import { fmtCost, fmtDuration, fmtInt, fmtPercent } from '../../observe/format';
import type { ObserveRollupRow } from '../../observe/types';
import { MetricCard } from '../../ui/MetricCard';
import { metricSummary, splitWindow } from './monitoringMetrics';
import type { ChartWindow, MonitoringWindow } from './monitoringSeries';

const points = (v: number) => `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })} pp`;

/**
 * The four KPI cards over the chart window: runs, error rate, p95 latency and
 * cost over the whole window (bucket in progress included), each with its
 * per-bucket sparkline and the change over the window's complete buckets
 * against as many just before it (`rows` reach back one window before `from`).
 */
export function MetricRow({
  rows,
  chart,
  win,
  loading,
}: {
  rows: ObserveRollupRow[];
  chart: ChartWindow;
  win: MonitoringWindow;
  loading: boolean;
}) {
  const split = splitWindow(rows, chart);
  const m = metricSummary(split.window, split.compare);
  const label = `vs previous ${win}`;
  const delta = (value: number | undefined, goodWhen: 'up' | 'down', format?: (v: number) => string) =>
    value === undefined ? undefined : { value, goodWhen, label, format };
  // The delta's label is spoken only; this is its visible (and screen-reader silent) counterpart.
  const vs = (value: number | undefined) =>
    value === undefined ? undefined : <span aria-hidden="true">vs prev. {win}</span>;
  // With a delta the visible line is the comparison; the weighting stays spoken (and in the tooltip).
  const p95Hint =
    m.p95.delta === undefined ? (
      'runs-weighted'
    ) : (
      <>
        {vs(m.p95.delta)}
        <span className="visually-hidden">, runs-weighted</span>
      </>
    );
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
          hint={loading ? undefined : p95Hint}
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
