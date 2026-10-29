import { describe, expect, it } from 'vitest';

import type { ObserveRollupRow } from '../../../observe/types';
import { metricSummary, splitWindow, windowTotals } from '../monitoringMetrics';
import { chartWindow, insightsSpan, WINDOWS, type MonitoringWindow } from '../monitoringSeries';

const HOUR = 3_600_000;
const T = Date.UTC(2026, 9, 25, 12);

const row = (agent_id: string, metric: string, value: number, bucket_start = T): ObserveRollupRow => ({
  bucket_start,
  granularity: 'hour',
  agent_id,
  metric,
  value,
});

describe('splitWindow', () => {
  // A 3-bucket window [T, T + 3h): two complete buckets, then the one still in progress.
  const w = { from: T, to: T + 3 * HOUR, bucketMs: HOUR };

  it('the window is every bucket from `from`; the deltas compare its complete buckets with as many before it', () => {
    const rows = [
      row('a', 'runs', 1, T - 3 * HOUR),
      row('a', 'runs', 2, T - 2 * HOUR),
      row('a', 'runs', 3, T - HOUR),
      row('a', 'runs', 4, T),
      row('a', 'runs', 5, T + HOUR),
      row('a', 'runs', 6, T + 2 * HOUR),
    ];
    const split = splitWindow(rows, w);
    expect(split.window.map((r) => r.value)).toEqual([4, 5, 6]);
    expect(split.compare?.current.map((r) => r.value)).toEqual([4, 5]);
    expect(split.compare?.previous.map((r) => r.value)).toEqual([2, 3]);
  });

  it('no comparison while the window has no complete bucket', () => {
    const split = splitWindow([row('a', 'runs', 1, T - HOUR), row('a', 'runs', 2, T)], { from: T, to: T + HOUR, bucketMs: HOUR });
    expect(split.window.map((r) => r.value)).toEqual([2]);
    expect(split.compare).toBeNull();
  });
});

describe('steady traffic, `now` pinned mid-bucket', () => {
  // 120 runs and $0.60 an hour, every hour; the bucket holding `now` has only its elapsed share.
  const PER_HOUR = 120;
  const steady = (win: MonitoringWindow, now: number) => {
    const w = chartWindow(win, now);
    const { since, until } = insightsSpan(w);
    const rows: ObserveRollupRow[] = [];
    for (let b = since; b < until; b += w.bucketMs) {
      const hours = (Math.min(b + w.bucketMs, now) - b) / HOUR;
      if (hours <= 0) continue;
      rows.push(row('a', 'runs', PER_HOUR * hours, b), row('a', 'cost_usd', 0.6 * hours, b));
    }
    return { w, rows };
  };

  for (const win of WINDOWS) {
    it(`${win}: runs and cost deltas are 0%`, () => {
      const now = Date.UTC(2026, 9, 25, 10, 5);
      const { w, rows } = steady(win, now);
      const split = splitWindow(rows, w);
      const m = metricSummary(split.window, split.compare);
      expect(m.runs.delta).toBeCloseTo(0, 9);
      expect(m.cost.delta).toBeCloseTo(0, 9);
      // The value still counts the bucket in progress.
      const visible = rows.filter((r) => r.metric === 'runs' && r.bucket_start >= w.from).reduce((a, r) => a + r.value, 0);
      expect(m.runs.value).toBeCloseTo(visible);
    });
  }

  it('1h at 10:05: the 5 minutes of the 10:00 bucket count in the value, not in the delta', () => {
    const { w, rows } = steady('1h', Date.UTC(2026, 9, 25, 10, 5));
    const split = splitWindow(rows, w);
    const m = metricSummary(split.window, split.compare);
    expect(m.runs.value).toBeCloseTo(PER_HOUR + PER_HOUR / 12);
    expect(m.runs.sparkline).toEqual([PER_HOUR, PER_HOUR / 12]);
    expect(m.runs.delta).toBeCloseTo(0, 9);
  });
});

describe('windowTotals', () => {
  it('sums runs, errors and cost across agents and buckets', () => {
    const rows = [
      row('a', 'runs', 4),
      row('b', 'runs', 6, T + HOUR),
      row('a', 'errors', 1),
      row('b', 'errors', 2, T + HOUR),
      row('a', 'cost_usd', 0.25),
      row('b', 'cost_usd', 0.5, T + HOUR),
    ];
    expect(windowTotals(rows)).toEqual({ runs: 10, errors: 3, cost: 0.75, p95: null });
  });

  it('p95 is the runs-weighted mean of the bucket p95 rows', () => {
    const rows = [row('a', 'runs', 3), row('b', 'runs', 1), row('a', 'p95_latency_ms', 1000), row('b', 'p95_latency_ms', 2000)];
    expect(windowTotals(rows).p95).toBe(1250);
  });

  it('p95 falls back to the plain mean when no p95 row has runs beside it', () => {
    const rows = [row('a', 'p95_latency_ms', 1000), row('b', 'p95_latency_ms', 2000)];
    expect(windowTotals(rows).p95).toBe(1500);
  });
});

describe('metricSummary', () => {
  const current = [
    row('a', 'runs', 10),
    row('a', 'errors', 2),
    row('a', 'cost_usd', 0.3),
    row('a', 'p95_latency_ms', 900),
    row('a', 'runs', 10, T + HOUR),
    row('a', 'errors', 0, T + HOUR),
    row('a', 'cost_usd', 0.1, T + HOUR),
    row('a', 'p95_latency_ms', 1100, T + HOUR),
  ];
  const previous = [
    row('a', 'runs', 10, T - HOUR),
    row('a', 'errors', 1, T - HOUR),
    row('a', 'cost_usd', 0.5, T - HOUR),
    row('a', 'p95_latency_ms', 2000, T - HOUR),
  ];

  it('values come from the current window; sparklines are its per-bucket values', () => {
    const m = metricSummary(current, { current, previous });
    expect(m.runs.value).toBe(20);
    expect(m.runs.sparkline).toEqual([10, 10]);
    expect(m.errorRate.value).toBeCloseTo(0.1);
    expect(m.errorRate.sparkline).toEqual([20, 0]);
    expect(m.p95.value).toBe(1000);
    expect(m.p95.sparkline).toEqual([900, 1100]);
    expect(m.cost.value).toBeCloseTo(0.4);
    expect(m.cost.sparkline).toEqual([0.3, 0.1]);
  });

  it('deltas: relative % for runs, p95 and cost; percentage points for error rate', () => {
    const m = metricSummary(current, { current, previous });
    expect(m.runs.delta).toBeCloseTo(100);
    expect(m.p95.delta).toBeCloseTo(-50);
    expect(m.cost.delta).toBeCloseTo(-20);
    expect(m.errorRate.delta).toBeCloseTo(0); // 10% vs 10%
  });

  it('no delta when the previous window has no rows, or a zero base', () => {
    const none = metricSummary(current, { current, previous: [] });
    expect([none.runs.delta, none.errorRate.delta, none.p95.delta, none.cost.delta]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const zero = metricSummary(current, { current, previous: [row('a', 'runs', 0, T - HOUR), row('a', 'cost_usd', 0, T - HOUR)] });
    expect([zero.runs.delta, zero.errorRate.delta, zero.cost.delta]).toEqual([undefined, undefined, undefined]);
  });

  it('no delta at all without a comparison (no complete bucket yet), though the values show', () => {
    const m = metricSummary(current, null);
    expect(m.runs.value).toBe(20);
    expect([m.runs.delta, m.errorRate.delta, m.p95.delta, m.cost.delta]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('deltas come from the comparison rows, values from the window rows', () => {
    const m = metricSummary(current, { current: current.filter((r) => r.bucket_start === T), previous });
    expect(m.runs.value).toBe(20);
    expect(m.runs.delta).toBeCloseTo(0); // 10 vs 10
    expect(m.cost.delta).toBeCloseTo(-40); // $0.30 vs $0.50
  });

  it('an empty current window has no error rate or p95 value', () => {
    const m = metricSummary([], { current: [], previous });
    expect(m.runs.value).toBe(0);
    expect(m.errorRate.value).toBeNull();
    expect(m.errorRate.delta).toBeUndefined();
    expect(m.p95.value).toBeNull();
    expect(m.p95.delta).toBeUndefined();
  });
});
