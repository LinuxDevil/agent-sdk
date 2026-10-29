import { describe, expect, it } from 'vitest';

import type { ObserveRollupRow } from '../../../observe/types';
import { chartWindow, insightsSpan, perAgentSeries, runsSeries } from '../monitoringSeries';

const T = Date.UTC(2026, 9, 25, 12);

const row = (agent_id: string, metric: string, value: number, bucket_start = T): ObserveRollupRow => ({
  bucket_start,
  granularity: 'hour',
  agent_id,
  metric,
  value,
});

describe('perAgentSeries', () => {
  it('keeps two agents in the same bucket as two series, never summed (p95_latency_ms)', () => {
    const rows = [row('a1', 'runs', 5), row('a2', 'runs', 2), row('a1', 'p95_latency_ms', 900), row('a2', 'p95_latency_ms', 400)];
    const { series, omitted } = perAgentSeries(rows, 'p95_latency_ms', (id) => id);
    expect(omitted).toBe(0);
    expect(series.map((s) => ({ id: s.id, points: s.points }))).toEqual([
      { id: 'a1', points: [{ t: T, v: 900 }] },
      { id: 'a2', points: [{ t: T, v: 400 }] },
    ]);
  });

  it('keeps two agents in the same bucket as two series, never summed (error_rate, scaled)', () => {
    const rows = [row('a1', 'error_rate', 0.5), row('a2', 'error_rate', 0.25)];
    const { series } = perAgentSeries(rows, 'error_rate', (id) => id, (v) => v * 100);
    expect(series).toHaveLength(2);
    expect(Object.fromEntries(series.map((s) => [s.id, s.points]))).toEqual({
      a1: [{ t: T, v: 50 }],
      a2: [{ t: T, v: 25 }],
    });
  });

  it('colours agents from the categorical chart palette', () => {
    const rows = [row('a1', 'runs', 5), row('a2', 'runs', 2), row('a1', 'p95_latency_ms', 900), row('a2', 'p95_latency_ms', 400)];
    expect(perAgentSeries(rows, 'p95_latency_ms', (id) => id).series.map((s) => s.color)).toEqual(['chart-1', 'chart-2']);
  });

  it('caps at 5 agents, busiest first, and counts the rest as omitted', () => {
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
    const rows = ids.flatMap((id, i) => [row(id, 'runs', i + 1), row(id, 'p95_latency_ms', 100)]);
    const { series, omitted } = perAgentSeries(rows, 'p95_latency_ms', (id) => id);
    expect(series.map((s) => s.id)).toEqual(['a7', 'a6', 'a5', 'a4', 'a3']);
    expect(omitted).toBe(2);
  });
});

describe('runsSeries', () => {
  it('sums the additive runs/errors across agents per bucket', () => {
    const rows = [row('a1', 'runs', 5), row('a2', 'runs', 3), row('a1', 'errors', 1), row('a2', 'errors', 1)];
    const [ok, error] = runsSeries(rows);
    expect(ok!.points).toEqual([{ t: T, v: 6 }]);
    expect(error!.points).toEqual([{ t: T, v: 2 }]);
  });
});

describe('insightsSpan', () => {
  it('reaches back one window span before the window, ending with it', () => {
    for (const win of ['1h', '24h', '7d', '30d'] as const) {
      const w = chartWindow(win, T + 1234);
      expect(insightsSpan(w)).toEqual({ since: w.from - (w.to - w.from), until: w.to });
    }
    const day = chartWindow('24h', T + 1234);
    expect(day.from - insightsSpan(day).since).toBe(25 * 3_600_000);
  });
});
