/**
 * Pure helpers for the Monitoring screen: the window choices, the bucket-aligned
 * chart window, and the rollup rows -> TimeSeriesChart series mapping.
 *
 * Additive metrics (runs, errors, cost_usd, input/output tokens) are summed
 * across agents per bucket. `p95_latency_ms` and `error_rate` are per-agent
 * values and are never summed: they become one series per agent, one point per
 * bucket (TimeSeriesChart sums points that share a bucket).
 */
import type { ObserveRollupRow } from '../../observe/types';
import type { SeriesColor, TimeSeries, TimeSeriesPoint } from '../../ui/TimeSeriesChart';

export const WINDOWS = ['1h', '24h', '7d', '30d'] as const;
export type MonitoringWindow = (typeof WINDOWS)[number];
const DEFAULT_WINDOW: MonitoringWindow = '24h';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WINDOW_MS: Record<MonitoringWindow, number> = { '1h': HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };

/** Per-agent series beyond this many are left off the chart (with a note). */
const MAX_AGENT_SERIES = 5;
const AGENT_COLORS: SeriesColor[] = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'];

/** `?window=`: one of {@link WINDOWS}; anything else is the default. */
export function parseWindow(s: string | null): MonitoringWindow {
  return (WINDOWS as readonly string[]).includes(s ?? '') ? (s as MonitoringWindow) : DEFAULT_WINDOW;
}

/** The default window is not written to the URL. */
export function formatWindow(w: MonitoringWindow): string | null {
  return w === DEFAULT_WINDOW ? null : w;
}

export interface ChartWindow {
  from: number;
  to: number;
  bucketMs: number;
  granularity: 'hour' | 'day';
}

/**
 * Hour buckets for 1h/24h, day buckets for 7d/30d, aligned to the daemon's UTC
 * rollup buckets: from the bucket holding `now - window` through the one holding `now`.
 */
export function chartWindow(window: MonitoringWindow, now: number): ChartWindow {
  const granularity = window === '1h' || window === '24h' ? 'hour' : 'day';
  const bucketMs = granularity === 'hour' ? HOUR : DAY;
  const to = now - (now % bucketMs) + bucketMs;
  const start = Math.max(0, now - WINDOW_MS[window]);
  const from = start - (start % bucketMs);
  return { from, to, bucketMs, granularity };
}

/**
 * The rollup query behind the charts and metric cards: the window plus the one
 * before it (same length), so the cards can show a change without a second
 * request. The deltas need one bucket less than that (they leave the bucket in
 * progress out of both sides; see `splitWindow`).
 */
export function insightsSpan(w: ChartWindow): { since: number; until: number } {
  return { since: w.from - (w.to - w.from), until: w.to };
}

/** Sum `metric` across agents into one point per bucket. */
function summed(rows: ObserveRollupRow[], metric: string): TimeSeriesPoint[] {
  const byBucket = new Map<number, number>();
  for (const row of rows) {
    if (row.metric === metric) byBucket.set(row.bucket_start, (byBucket.get(row.bucket_start) ?? 0) + row.value);
  }
  return [...byBucket.entries()].sort(([a], [b]) => a - b).map(([t, v]) => ({ t, v }));
}

/** Runs split into ok (runs - errors) and error, summed across agents. */
export function runsSeries(rows: ObserveRollupRow[]): TimeSeries[] {
  const errors = new Map(summed(rows, 'errors').map((p) => [p.t, p.v]));
  const runs = summed(rows, 'runs');
  return [
    { id: 'ok', label: 'OK', color: 'success', points: runs.map((p) => ({ t: p.t, v: Math.max(0, p.v - (errors.get(p.t) ?? 0)) })) },
    { id: 'error', label: 'Error', color: 'danger', points: runs.map((p) => ({ t: p.t, v: errors.get(p.t) ?? 0 })) },
  ];
}

export function tokenSeries(rows: ObserveRollupRow[]): TimeSeries[] {
  return [
    { id: 'input', label: 'Input', color: 'chart-1', points: summed(rows, 'input_tokens') },
    { id: 'output', label: 'Output', color: 'chart-2', points: summed(rows, 'output_tokens') },
  ];
}

export function costSeries(rows: ObserveRollupRow[]): TimeSeries[] {
  return [{ id: 'cost', label: 'Cost', color: 'chart-1', points: summed(rows, 'cost_usd') }];
}

export interface PerAgentSeries {
  series: TimeSeries[];
  /** Agents with data that were left off (over {@link MAX_AGENT_SERIES}). */
  omitted: number;
}

/**
 * One series per agent for a non-additive metric, busiest agents (by runs in
 * the rows) first, capped at {@link MAX_AGENT_SERIES}. `scale` maps the stored
 * value (e.g. a 0..1 rate to percent).
 */
export function perAgentSeries(
  rows: ObserveRollupRow[],
  metric: string,
  agentLabel: (agentId: string) => string,
  scale: (v: number) => number = (v) => v,
): PerAgentSeries {
  const runs = new Map<string, number>();
  const points = new Map<string, TimeSeriesPoint[]>();
  for (const row of rows) {
    if (row.metric === 'runs') runs.set(row.agent_id, (runs.get(row.agent_id) ?? 0) + row.value);
    if (row.metric !== metric) continue;
    const list = points.get(row.agent_id) ?? [];
    list.push({ t: row.bucket_start, v: scale(row.value) });
    points.set(row.agent_id, list);
  }
  const ids = [...points.keys()].sort((a, b) => (runs.get(b) ?? 0) - (runs.get(a) ?? 0) || a.localeCompare(b));
  const series = ids.slice(0, MAX_AGENT_SERIES).map((id, i) => ({
    id,
    label: agentLabel(id),
    color: AGENT_COLORS[i % AGENT_COLORS.length]!,
    points: points.get(id)!.sort((a, b) => a.t - b.t),
  }));
  return { series, omitted: Math.max(0, ids.length - MAX_AGENT_SERIES) };
}

/** The Traces deep link for a clicked bucket (`from`/`to` half-open ms, plus the agent when filtered). */
export function bucketTracesPath(from: number, to: number, agentId: string): string {
  const q = new URLSearchParams({ from: String(from), to: String(to) });
  if (agentId) q.set('agent', agentId);
  return `/traces?${q.toString()}`;
}
