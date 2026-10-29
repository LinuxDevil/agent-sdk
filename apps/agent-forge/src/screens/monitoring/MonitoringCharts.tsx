import type { ReactNode } from 'react';
import { LineChart } from 'lucide-react';

import { fmtDuration, fmtInt, fmtPercent } from '../../observe/format';
import type { ObserveRollupRow } from '../../observe/types';
import { Card } from '../../ui/Card';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
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

const CHART_HEIGHT = 200;

/** Each chart card's title and one-line description, in grid order (Tokens spans the row). */
const CHARTS = [
  { title: 'Runs', description: 'Completed runs per bucket, OK and failed' },
  { title: 'Latency p95', description: '95th percentile run latency, per agent' },
  { title: 'Error rate', description: 'Share of runs that failed, per agent' },
  { title: 'Cost', description: 'Model spend across all agents (USD)' },
  { title: 'Tokens', description: 'Input and output tokens across all agents' },
] as const;
type ChartTitle = (typeof CHARTS)[number]['title'];
const DESCRIPTION = Object.fromEntries(CHARTS.map((c) => [c.title, c.description])) as Record<ChartTitle, string>;

/** Cost axis and tooltip labels: three significant digits, so neighbouring ticks never read the same. */
function fmtCostTick(usd: number): string {
  if (usd === 0) return '$0';
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${Number(usd.toPrecision(3))}`;
}

/** A chart grid cell: `.mon-chart` + `data-chart` (e2e and docShots find charts by them) around a titled Card. */
function ChartCell({ title, wide, children }: { title: ChartTitle; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`mon-chart${wide ? ' mon-chart-wide' : ''}`} data-chart={title}>
      <Card title={title} description={DESCRIPTION[title]}>
        {children}
      </Card>
    </div>
  );
}

function ChartCard({
  title,
  series,
  yFormat,
  note,
  area = true,
  window: w,
  onBucketClick,
}: Pick<ChartsProps, 'window' | 'onBucketClick'> & {
  title: ChartTitle;
  series: TimeSeries[];
  yFormat: (v: number) => string;
  note?: ReactNode;
  area?: boolean;
}) {
  return (
    <ChartCell title={title} wide={title === 'Tokens'}>
      <TimeSeriesChart
        series={series}
        from={w.from}
        to={w.to}
        bucketMs={w.bucketMs}
        yFormat={yFormat}
        onBucketClick={onBucketClick}
        height={CHART_HEIGHT}
        area={area}
      />
      {note && <p className="mon-chart-note">{note}</p>}
    </ChartCell>
  );
}

function omittedNote({ omitted }: PerAgentSeries): ReactNode {
  return omitted > 0 ? `${omitted} more agent${omitted === 1 ? '' : 's'} not shown - pick one in the agent filter.` : undefined;
}

/**
 * The five Monitoring charts over one window, two per row (one below 1100 px).
 * Runs, Cost and Tokens sum across agents (with an area fill); Latency (p95 -
 * the rollups carry no p50) and Error rate are plain lines per agent. Every
 * chart's bucket click goes to that bucket's traces.
 */
export function MonitoringCharts({ rows, window: w, agentLabel, onBucketClick }: ChartsProps) {
  const latency = perAgentSeries(rows, 'p95_latency_ms', agentLabel);
  const errorRate = perAgentSeries(rows, 'error_rate', agentLabel, (v) => v * 100);
  const shared = { window: w, onBucketClick };
  return (
    <div className="mon-charts">
      <ChartCard title="Runs" series={runsSeries(rows)} yFormat={fmtInt} {...shared} />
      <ChartCard title="Latency p95" series={latency.series} yFormat={fmtDuration} note={omittedNote(latency)} area={false} {...shared} />
      <ChartCard
        title="Error rate"
        series={errorRate.series}
        yFormat={(v) => fmtPercent(v / 100)}
        note={omittedNote(errorRate)}
        area={false}
        {...shared}
      />
      <ChartCard title="Cost" series={costSeries(rows)} yFormat={fmtCostTick} {...shared} />
      <ChartCard title="Tokens" series={tokenSeries(rows)} yFormat={fmtInt} {...shared} />
    </div>
  );
}

/** The chart grid while the first rollup query is in flight: each card with a skeleton plot. */
export function MonitoringChartsLoading() {
  return (
    <div className="mon-charts" aria-busy="true">
      <span className="visually-hidden" role="status">
        Loading charts
      </span>
      {CHARTS.map(({ title }) => (
        <ChartCell key={title} title={title} wide={title === 'Tokens'}>
          <Skeleton className="mon-chart-skeleton" width="100%" height={CHART_HEIGHT} radius="var(--radius)" />
        </ChartCell>
      ))}
    </div>
  );
}

/** No rollup rows in the window (for this agent): one card with the empty state. */
export function MonitoringChartsEmpty() {
  return (
    <Card as="div" className="mon-charts-empty">
      <EmptyState
        icon={LineChart}
        title="No runs in this window"
        hint="Charts fill in as agents report runs; try a longer window or another agent."
      />
    </Card>
  );
}
