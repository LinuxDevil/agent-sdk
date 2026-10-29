import { describe, expect, it } from 'vitest';

import type { ObserveRollupRow } from '../../../observe/types';
import { metricSummary, splitWindow, windowTotals } from '../monitoringMetrics';

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
  it('splits rows at the window start: earlier buckets are the previous window', () => {
    const rows = [row('a', 'runs', 1, T - HOUR), row('a', 'runs', 2, T), row('a', 'runs', 3, T + HOUR)];
    const { current, previous } = splitWindow(rows, T);
    expect(current.map((r) => r.value)).toEqual([2, 3]);
    expect(previous.map((r) => r.value)).toEqual([1]);
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
    const m = metricSummary(current, previous);
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
    const m = metricSummary(current, previous);
    expect(m.runs.delta).toBeCloseTo(100);
    expect(m.p95.delta).toBeCloseTo(-50);
    expect(m.cost.delta).toBeCloseTo(-20);
    expect(m.errorRate.delta).toBeCloseTo(0); // 10% vs 10%
  });

  it('no delta when the previous window has no rows, or a zero base', () => {
    const none = metricSummary(current, []);
    expect([none.runs.delta, none.errorRate.delta, none.p95.delta, none.cost.delta]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const zero = metricSummary(current, [row('a', 'runs', 0, T - HOUR), row('a', 'cost_usd', 0, T - HOUR)]);
    expect([zero.runs.delta, zero.errorRate.delta, zero.cost.delta]).toEqual([undefined, undefined, undefined]);
  });

  it('an empty current window has no error rate or p95 value', () => {
    const m = metricSummary([], previous);
    expect(m.runs.value).toBe(0);
    expect(m.errorRate.value).toBeNull();
    expect(m.errorRate.delta).toBeUndefined();
    expect(m.p95.value).toBeNull();
    expect(m.p95.delta).toBeUndefined();
  });
});
