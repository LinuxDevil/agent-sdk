/**
 * Pure helpers for the Monitoring metric cards: the window's totals (runs,
 * error rate, p95 latency, cost), their per-bucket sparklines, and the change
 * against the previous window of the same length.
 *
 * The screen fetches one rollup query reaching back two window spans and
 * splits it at the window start ({@link splitWindow}); the charts and values
 * use the current half, the deltas compare against the earlier one.
 */
import type { ObserveRollupRow } from '../../observe/types';

/** The additive totals of a window, plus its runs-weighted p95 (`null` without p95 rows). */
export interface WindowTotals {
  runs: number;
  errors: number;
  cost: number;
  p95: number | null;
}

/** One metric card's figures: `delta` is undefined when there is no previous window to compare. */
export interface MetricFigure {
  value: number | null;
  delta?: number;
  sparkline: number[];
}

/** Runs, error rate (0..1), p95 latency (ms) and cost (USD) for the current window. */
export interface MetricSummary {
  runs: MetricFigure;
  errorRate: MetricFigure;
  p95: MetricFigure;
  cost: MetricFigure;
}

/** Rows in buckets starting at or after `from` are the current window; earlier ones the previous window. */
export function splitWindow(rows: ObserveRollupRow[], from: number): { current: ObserveRollupRow[]; previous: ObserveRollupRow[] } {
  return { current: rows.filter((r) => r.bucket_start >= from), previous: rows.filter((r) => r.bucket_start < from) };
}

const sum = (rows: ObserveRollupRow[], metric: string) =>
  rows.reduce((acc, r) => (r.metric === metric ? acc + r.value : acc), 0);

/**
 * The mean of the bucket p95 rows across agents, each weighted by its bucket's
 * runs (the plain mean when none has runs beside it); `null` without p95 rows.
 */
function weightedP95(rows: ObserveRollupRow[]): number | null {
  const key = (r: ObserveRollupRow) => `${r.bucket_start}:${r.agent_id}`;
  const runs = new Map(rows.filter((r) => r.metric === 'runs').map((r) => [key(r), r.value]));
  const p95s = rows.filter((r) => r.metric === 'p95_latency_ms');
  if (p95s.length === 0) return null;
  let weighted = 0;
  let weight = 0;
  for (const r of p95s) {
    const w = runs.get(key(r)) ?? 0;
    weighted += r.value * w;
    weight += w;
  }
  return weight > 0 ? weighted / weight : p95s.reduce((acc, r) => acc + r.value, 0) / p95s.length;
}

export function windowTotals(rows: ObserveRollupRow[]): WindowTotals {
  return { runs: sum(rows, 'runs'), errors: sum(rows, 'errors'), cost: sum(rows, 'cost_usd'), p95: weightedP95(rows) };
}

const errorRate = (t: WindowTotals): number | null => (t.runs > 0 ? t.errors / t.runs : null);

/** Relative change in percent; undefined without a positive base or a current value. */
function relative(current: number | null, previous: number | null): number | undefined {
  if (current === null || previous === null || !(previous > 0)) return undefined;
  return ((current - previous) / previous) * 100;
}

/** Each present bucket's totals, oldest first. */
function perBucket(rows: ObserveRollupRow[]): WindowTotals[] {
  const buckets = new Map<number, ObserveRollupRow[]>();
  for (const r of rows) buckets.set(r.bucket_start, [...(buckets.get(r.bucket_start) ?? []), r]);
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([, list]) => windowTotals(list));
}

const present = (values: (number | null)[]): number[] => values.filter((v): v is number => v !== null);

/**
 * The four Monitoring metric cards. Runs, p95 and cost deltas are relative %
 * changes; the error-rate delta is in percentage points. A previous window
 * with no runs (or no p95 / cost) gives no delta.
 */
export function metricSummary(current: ObserveRollupRow[], previous: ObserveRollupRow[]): MetricSummary {
  const now = windowTotals(current);
  const before = windowTotals(previous);
  const buckets = perBucket(current);
  const rate = errorRate(now);
  const prevRate = errorRate(before);
  return {
    runs: { value: now.runs, delta: relative(now.runs, before.runs), sparkline: buckets.map((b) => b.runs) },
    errorRate: {
      value: rate,
      delta: rate === null || prevRate === null ? undefined : (rate - prevRate) * 100,
      sparkline: present(buckets.map((b) => (b.runs > 0 ? (b.errors * 100) / b.runs : null))),
    },
    p95: { value: now.p95, delta: relative(now.p95, before.p95), sparkline: present(buckets.map((b) => b.p95)) },
    cost: { value: now.cost, delta: relative(now.cost, before.cost), sparkline: buckets.map((b) => b.cost) },
  };
}
