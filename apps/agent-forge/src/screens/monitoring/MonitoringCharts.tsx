import type { ReactNode } from 'react';
import { fmtCost, fmtDuration, fmtInt, fmtPercent } from '../../observe/format';
import type { ObserveRollupRow } from '../../observe/types';
import { TimeSeriesChart, type TimeSeries } from '../../ui/TimeSeriesChart';
import {
  costSeries,
  perAgentSeries,
  runsSeries,
  tokenSeries,
  type ChartWindow,
  type PerAgentSeries,
} from './monitoringSeries';

interface ChartsProps {
  rows: ObserveRollupRow[];
  window: ChartWindow;
  agentLabel: (agentId: string) => string;
  onBucketClick: (from: number, to: number) => void;
}

function ChartCard({
  title,
  series,
  yFormat,
  note,
  window: w,
  onBucketClick,
}: Pick<ChartsProps, 'window' | 'onBucketClick'> & {
  title: string;
  series: TimeSeries[];
  yFormat: (v: number) => string;
  note?: ReactNode;
}) {
  return (
    <section className="mon-chart" aria-label={title} data-chart={title}>
      <h3 className="mon-chart-title">{title}</h3>
      <TimeSeriesChart
        series={series}
        from={w.from}
        to={w.to}
        bucketMs={w.bucketMs}
        yFormat={yFormat}
        onBucketClick={onBucketClick}
        height={180}
      />
      {note && <p className="mon-chart-note">{note}</p>}
    </section>
  );
}

function omittedNote({ omitted }: PerAgentSeries): ReactNode {
  return omitted > 0 ? `${omitted} more agent${omitted === 1 ? '' : 's'} not shown - pick one in the agent filter.` : undefined;
}

/**
 * The five Monitoring charts over one window. Runs, Cost and Tokens sum across
 * agents; Latency (p95 - the rollups carry no p50) and Error rate are drawn
 * per agent. Every chart's bucket click goes to that bucket's traces.
 */
export function MonitoringCharts({ rows, window: w, agentLabel, onBucketClick }: ChartsProps) {
  const latency = perAgentSeries(rows, 'p95_latency_ms', agentLabel);
  const errorRate = perAgentSeries(rows, 'error_rate', agentLabel, (v) => v * 100);
  const shared = { window: w, onBucketClick };
  return (
    <div className="mon-charts">
      <ChartCard title="Runs" series={runsSeries(rows)} yFormat={fmtInt} {...shared} />
      <ChartCard title="Latency p95" series={latency.series} yFormat={fmtDuration} note={omittedNote(latency)} {...shared} />
      <ChartCard
        title="Error rate"
        series={errorRate.series}
        yFormat={(v) => fmtPercent(v / 100)}
        note={omittedNote(errorRate)}
        {...shared}
      />
      <ChartCard title="Cost" series={costSeries(rows)} yFormat={fmtCost} {...shared} />
      <ChartCard title="Tokens" series={tokenSeries(rows)} yFormat={fmtInt} {...shared} />
    </div>
  );
}
