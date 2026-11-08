import type { SqlDatabase } from '../storage/sqlite/driver';
import { finishedRuns } from './store';

/** One run's value in the series: the mean of its online scores, or 0 when it failed and 1 when it passed with no score. */
export interface ScorePoint {
  traceId: string;
  /** When the run started, in epoch milliseconds. */
  at: number;
  /** The run's `lousho.harness.revision`, when it was stamped. */
  revision?: string;
  /** In [0, 1]; 0.5 or more counts as a pass. */
  value: number;
}

/** Paper B's trajectory gate verdict: `stall` is a long flat run below the floor, `regression` a fall below the running peak. */
export interface TrajectoryVerdict {
  state: 'ok' | 'stall' | 'regression';
  /** The best rolling mean seen, or the mean of the points before the first full window. */
  peak: number;
  /** Points since the last gain (since the first full window, or all points before it). */
  sinceGain: number;
}

/** A window's summary; a value of 0.5 or more is a pass. */
export interface WindowStat {
  runs: number;
  mean: number;
  passRate: number;
  /** pass^3, the chance that three runs all pass, estimated as C(passes, 3) / C(runs, 3); absent below three runs. */
  pass3?: number;
  /** One-sided 95% Wilson lower bound on the pass rate. */
  lower: number;
  /** One-sided 95% Wilson upper bound on the pass rate. */
  upper: number;
}

const ONE_SIDED_95 = 1.6448536269514722;

const PASS = 0.5;
const EPSILON = 1e-9;
const SERIES_DEFAULT_LIMIT = 1000;

/** The series for one agent, oldest first. */
export function scoreSeries(db: SqlDatabase, filter: { agent: string; revision?: string; since?: number; limit?: number }): ScorePoint[] {
  return finishedRuns(db, { ...filter, limit: filter.limit ?? SERIES_DEFAULT_LIMIT })
    .reverse()
    .map((run) => ({ traceId: run.traceId, at: run.startedAt, ...(run.revision !== undefined && { revision: run.revision }), value: run.score ?? (run.failed ? 0 : 1) }));
}

function rollingMeans(values: readonly number[], window: number): number[] {
  let sum = 0;
  return values.map((value, i) => {
    sum += value - (i >= window ? values[i - window] : 0);
    return sum / Math.min(i + 1, window);
  });
}

/** Paper B's trajectory gate over a series. */
export function trajectoryGate(points: readonly ScorePoint[], options: { window?: number; floor?: number; gain?: number; drop?: number } = {}): TrajectoryVerdict {
  const { window = 10, floor = 0.5, gain = 0.02, drop = 0.15 } = options;
  const means = rollingMeans(
    points.map((point) => point.value),
    window
  );
  if (means.length < window) return { state: 'ok', peak: means.at(-1) ?? 0, sinceGain: means.length };
  let peak = means[window - 1];
  let sinceGain = 0;
  for (const mean of means.slice(window)) {
    if (mean - peak >= gain - EPSILON) {
      peak = mean;
      sinceGain = 0;
      continue;
    }
    sinceGain += 1;
    if (mean < peak - drop - EPSILON) return { state: 'regression', peak, sinceGain };
    if (sinceGain >= window && peak < floor) return { state: 'stall', peak, sinceGain };
  }
  return { state: 'ok', peak, sinceGain };
}

/** The Wilson score bounds on a pass rate; `z` defaults to a one-sided 95% bound. */
export function wilsonBounds(passes: number, runs: number, z: number = ONE_SIDED_95): { lower: number; upper: number } {
  if (runs === 0) return { lower: 0, upper: 1 };
  const rate = passes / runs;
  const z2 = z * z;
  const scale = 1 + z2 / runs;
  const centre = (rate + z2 / (2 * runs)) / scale;
  const half = (z * Math.sqrt((rate * (1 - rate)) / runs + z2 / (4 * runs * runs))) / scale;
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

function passCubed(passes: number, runs: number): number {
  return (passes * (passes - 1) * (passes - 2)) / (runs * (runs - 1) * (runs - 2));
}

/** Windowed summary: mean, pass rate, pass^k over repeated inputs, and a one-sided 95% Wilson lower bound on the pass rate. */
export function windowSummary(points: readonly ScorePoint[]): WindowStat {
  const runs = points.length;
  if (runs === 0) return { runs: 0, mean: 0, passRate: 0, lower: 0, upper: 1 };
  const passes = points.filter((point) => point.value >= PASS).length;
  const mean = points.reduce((sum, point) => sum + point.value, 0) / runs;
  return { runs, mean, passRate: passes / runs, ...(runs >= 3 && { pass3: passCubed(passes, runs) }), ...wilsonBounds(passes, runs) };
}
