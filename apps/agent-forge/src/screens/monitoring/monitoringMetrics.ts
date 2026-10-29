/**
 * Pure helpers for the Monitoring metric cards: the window's totals (runs,
 * error rate, p95 latency, cost), their per-bucket sparklines, and the change
 * against the previous window of the same length.
 *
 * The screen fetches one rollup query reaching back two window spans and
 * splits it ({@link splitWindow}): the charts, values and sparklines use the
 * whole window, bucket in progress included; the deltas compare like with
 * like - the window's complete buckets against as many complete buckets just
 * before it.
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

/** The bucket grid a window's rows are split on (a `ChartWindow` is one). */
export interface BucketWindow {
  /** Start of the window's first bucket. */
  from: number;
  /** End of the bucket holding `now`, the one still in progress. */
  to: number;
  bucketMs: number;
}

/** What the deltas compare: two runs of the same number of complete buckets. */
export interface WindowComparison {
  /** The window's complete buckets: `[from, to - bucketMs)`. */
  current: ObserveRollupRow[];
  /** As many buckets immediately before `from`. */
  previous: ObserveRollupRow[];
}

/**
 * `window` is every row from `from` on (the charts, values and sparklines);
 * `compare` leaves the in-progress bucket out so both sides span the same
 * number of complete buckets, and is `null` while the window has none.
 */
export function splitWindow(
  rows: ObserveRollupRow[],
  w: BucketWindow,
): { window: ObserveRollupRow[]; compare: WindowComparison | null } {
  const completeEnd = w.to - w.bucketMs;
  const prevStart = w.from - (completeEnd - w.from);
  const within = (start: number, end: number) => rows.filter((r) => r.bucket_start >= start && r.bucket_start < end);
  return {
    window: rows.filter((r) => r.bucket_start >= w.from),
    compare: completeEnd > w.from ? { current: within(w.from, completeEnd), previous: within(prevStart, w.from) } : null,
  };
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

/** The four deltas of `compare` (all undefined without one). */
function deltas(compare: WindowComparison | null) {
  if (compare === null) return { runs: undefined, errorRate: undefined, p95: undefined, cost: undefined };
  const now = windowTotals(compare.current);
  const before = windowTotals(compare.previous);
  const rate = errorRate(now);
  const prevRate = errorRate(before);
  return {
    runs: relative(now.runs, before.runs),
    errorRate: rate === null || prevRate === null ? undefined : (rate - prevRate) * 100,
    p95: relative(now.p95, before.p95),
    cost: relative(now.cost, before.cost),
  };
}

/**
 * The four Monitoring metric cards: values and sparklines over `window`,
 * deltas over `compare` (see {@link splitWindow}). Runs, p95 and cost deltas
 * are relative % changes; the error-rate delta is in percentage points. No
 * comparison, or a previous side with no runs (or no p95 / cost), gives no delta.
 */
export function metricSummary(window: ObserveRollupRow[], compare: WindowComparison | null): MetricSummary {
  const now = windowTotals(window);
  const buckets = perBucket(window);
  const d = deltas(compare);
  return {
    runs: { value: now.runs, delta: d.runs, sparkline: buckets.map((b) => b.runs) },
    errorRate: {
      value: errorRate(now),
      delta: d.errorRate,
      sparkline: present(buckets.map((b) => (b.runs > 0 ? (b.errors * 100) / b.runs : null))),
    },
    p95: { value: now.p95, delta: d.p95, sparkline: present(buckets.map((b) => b.p95)) },
    cost: { value: now.cost, delta: d.cost, sparkline: buckets.map((b) => b.cost) },
  };
}
