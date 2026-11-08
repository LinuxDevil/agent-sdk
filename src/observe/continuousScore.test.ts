import { describe, expect, it } from 'vitest';
import type { IngestEvent } from './envelope';
import { scoreSeries, trajectoryGate, wilsonBounds, windowSummary, type ScorePoint } from './continuousScore';
import { ingestBatch, openDb } from './store';

const T0 = 1_790_000_000_000;
const R1 = 'a'.repeat(64);
const R2 = 'b'.repeat(64);

const series = (values: readonly number[]): ScorePoint[] => values.map((value, i) => ({ traceId: `t${i}`, at: T0 + i, value }));
const repeat = (value: number, times: number): number[] => Array.from({ length: times }, () => value);

function root(trace: string, at: number, attrs: Record<string, unknown> = {}, over: Record<string, unknown> = {}): IngestEvent {
  return {
    type: 'observation',
    data: {
      obs_id: `root-${trace}`,
      trace_id: trace,
      agent_id: 'support',
      kind: 'span',
      name: 'invoke_agent support',
      start: at,
      end: at + 10,
      status: 'ok',
      attrs: { 'gen_ai.operation.name': 'invoke_agent', 'lousho.run.finish_reason': 'stop', 'lousho.harness.revision': R1, ...attrs },
      ...over,
    },
  } as IngestEvent;
}

const score = (id: string, trace: string, value: number | undefined, source = 'online'): IngestEvent =>
  ({ type: 'score', data: { score_id: id, trace_id: trace, name: 'quality', ...(value !== undefined && { value }), source, agent_id: 'support', ts: T0 } }) as IngestEvent;

describe('trajectoryGate', () => {
  it.each([
    ['steady passing series is ok', repeat(1, 30), 'ok', 1, 20],
    ['ten points below 0.5 with no gain is a stall', repeat(0.3, 20), 'stall', 0.3, 10],
    ['nine such points are not yet a stall', repeat(0.3, 19), 'ok', 0.3, 9],
    ['a plateau above the floor is not a stall', repeat(0.6, 40), 'ok', 0.6, 30],
    ['a drop of 0.15 below the peak is a regression', [...repeat(0.9, 10), ...repeat(0.7, 10)], 'regression', 0.9, 8],
    ['a drop of exactly 0.15 is not', [...repeat(0.9, 10), ...repeat(0.75, 10)], 'ok', 0.9, 10],
    ['a low start that keeps improving is not a stall', [...repeat(0.2, 9), ...repeat(0.9, 11)], 'ok', 0.9, 1],
    ['fewer points than one window are ok', repeat(0, 9), 'ok', 0, 9],
  ] as const)('%s', (_name, values, state, peak, sinceGain) => {
    const result = trajectoryGate(series(values));
    expect(result.state).toBe(state);
    expect(result.peak).toBeCloseTo(peak, 10);
    expect(result.sinceGain).toBe(sinceGain);
  });

  it('a gain resets the counter', () => {
    expect(trajectoryGate(series(repeat(0.3, 20))).state).toBe('stall');
    const climbing = trajectoryGate(series([...repeat(0.3, 10), ...repeat(0.4, 10)]));
    expect(climbing.state).toBe('ok');
    expect(climbing.peak).toBeCloseTo(0.4, 10);
    expect(climbing.sinceGain).toBe(0);
  });

  it('judges the rolling mean, so one failed run in a passing series is not a regression', () => {
    expect(trajectoryGate(series([...repeat(1, 12), 0, ...repeat(1, 5)])).state).toBe('ok');
  });

  it('takes the window, floor, gain and drop as options', () => {
    expect(trajectoryGate(series([1, 1, 0.5]), { window: 1, drop: 0.4 }).state).toBe('regression');
    expect(trajectoryGate(series(repeat(0.7, 20)), { floor: 0.8 }).state).toBe('stall');
    expect(trajectoryGate(series([...repeat(0.5, 10), 0.51]), { gain: 0.001 }).sinceGain).toBe(0);
  });

  it('is ok with no points', () => {
    expect(trajectoryGate([])).toEqual({ state: 'ok', peak: 0, sinceGain: 0 });
  });
});

describe('wilsonBounds', () => {
  it.each([
    [16, 20, 0.62162, 0.90688],
    [12, 20, 0.41856, 0.75761],
    [20, 20, 0.88084, 1],
    [0, 20, 0, 0.11916],
  ])('%i of %i passes: one-sided 95%% bounds %f to %f', (passes, runs, lower, upper) => {
    const bounds = wilsonBounds(passes, runs);
    expect(bounds.lower).toBeCloseTo(lower, 4);
    expect(bounds.upper).toBeCloseTo(upper, 4);
  });

  it('takes another z, and says nothing for no runs', () => {
    expect(wilsonBounds(16, 20, 1.959963984540054).lower).toBeCloseTo(0.58398, 4);
    expect(wilsonBounds(0, 0)).toEqual({ lower: 0, upper: 1 });
  });
});

describe('windowSummary', () => {
  it('counts a value of 0.5 or more as a pass, with pass^3 and the Wilson bounds', () => {
    const summary = windowSummary(series([...repeat(1, 14), 0.5, 0.75, 0.4, 0, 0, 0.1]));
    expect(summary).toMatchObject({ runs: 20, passRate: 0.8 });
    expect(summary.mean).toBeCloseTo((14 + 0.5 + 0.75 + 0.4 + 0.1) / 20, 10);
    expect(summary.pass3).toBeCloseTo((16 * 15 * 14) / (20 * 19 * 18), 10);
    expect(summary.lower).toBeCloseTo(0.62162, 4);
    expect(summary.upper).toBeCloseTo(0.90688, 4);
  });

  it('is empty-safe and leaves pass^3 out below three runs', () => {
    expect(windowSummary([])).toEqual({ runs: 0, mean: 0, passRate: 0, lower: 0, upper: 1 });
    expect(windowSummary(series([1, 1]))).not.toHaveProperty('pass3');
  });
});

describe('scoreSeries', () => {
  it('is oldest first: online score means, else 0 for a failed run and 1 for a clean one', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [
      root('t1', T0),
      root('t2', T0 + 1, { 'lousho.run.finish_reason': 'max-steps' }),
      root('t3', T0 + 2),
      score('s1', 't3', 0.4),
      score('s2', 't3', 0.8),
      root('t4', T0 + 3, { 'lousho.harness.revision': R2 }),
    ]);

    expect(scoreSeries(db, { agent: 'support' })).toEqual([
      { traceId: 't1', at: T0, revision: R1, value: 1 },
      { traceId: 't2', at: T0 + 1, revision: R1, value: 0 },
      { traceId: 't3', at: T0 + 2, revision: R1, value: expect.closeTo(0.6, 10) as unknown as number },
      { traceId: 't4', at: T0 + 3, revision: R2, value: 1 },
    ]);
    expect(scoreSeries(db, { agent: 'support', revision: R2 }).map((point) => point.traceId)).toEqual(['t4']);
    expect(scoreSeries(db, { agent: 'support', limit: 2 }).map((point) => point.traceId)).toEqual(['t3', 't4']);
    expect(scoreSeries(db, { agent: 'support', since: T0 + 2 }).map((point) => point.traceId)).toEqual(['t3', 't4']);
    db.close();
  });

  it('pending scores are excluded', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [root('t1', T0), score('s1', 't1', undefined), score('s2', 't1', 0.9), root('t2', T0 + 1, {}, { end: undefined, status: undefined }), root('t3', T0 + 2), score('s3', 't3', undefined)]);

    expect(scoreSeries(db, { agent: 'support' })).toEqual([
      { traceId: 't1', at: T0, revision: R1, value: 0.9 },
      { traceId: 't3', at: T0 + 2, revision: R1, value: 1 },
    ]);
    db.close();
  });

  it('keeps a run with no revision stamp, without a revision', () => {
    const db = openDb(':memory:');
    ingestBatch(db, [root('t1', T0, { 'lousho.harness.revision': undefined })]);

    expect(scoreSeries(db, { agent: 'support' })).toEqual([{ traceId: 't1', at: T0, value: 1 }]);
    db.close();
  });
});
