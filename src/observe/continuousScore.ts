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

/** Paper B's trajectory gate verdict on the newest window of a series. */
export interface TrajectoryVerdict {
  state: 'ok' | 'stall' | 'regression';
  /** False until the series holds one full window; the state is then always `ok`. */
  ready: boolean;
  /** The best rolling mean since the first full window, or the mean so far before one. */
  peak: number;
  /** The rolling mean of the newest window. */
  mean: number;
  /** Windows since the last gain, counted from the first full window. */
  sinceGain: number;
}

/** Options of {@link trajectoryGate}; the defaults follow Paper B. */
export interface TrajectoryOptions {
  /** Points per rolling window, and the windows without a gain that make a stall; default 10. */
  window?: number;
  /** A stall needs the peak below this; default 0.5. */
  floor?: number;
  /** A rise above the peak by at least this is a gain; default 0.02. */
  gain?: number;
  /** A fall below the peak by more than this is a regression, when the newest window is also significantly below the points before it; default 0.15. */
  drop?: number;
  /** The z of that significance test; default a one-sided 95% bound. */
  z?: number;
}

/** A window's summary; a value of 0.5 or more is a pass. */
export interface WindowStat {
  /** How many runs the window holds. */
  runs: number;
  /** The mean point value. */
  mean: number;
  /** The share of runs that passed. */
  passRate: number;
  /** pass^3, the chance that three independent runs all pass, estimated as C(passes, 3) / C(runs, 3); absent below three runs. */
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

/** The series for one agent (its exact agent id), or for every agent when it is left out, oldest first. */
export function scoreSeries(db: SqlDatabase, filter: { agent?: string; revision?: string; since?: number; limit?: number }): ScorePoint[] {
  const { agent, ...rest } = filter;
  return finishedRuns(db, { ...rest, ...(agent !== undefined && { agentId: agent }), limit: filter.limit ?? SERIES_DEFAULT_LIMIT })
    .reverse()
    .map((run) => ({ traceId: run.traceId, at: run.startedAt, ...(run.revision !== undefined && { revision: run.revision }), value: run.score ?? (run.failed ? 0 : 1) }));
}

const meanOf = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);

const passesOf = (values: readonly number[]): number => values.filter((value) => value >= PASS).length;

function variance(values: readonly number[]): number {
  const mean = meanOf(values);
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1);
}

function rateDropIsSignificant(before: readonly number[], after: readonly number[], z: number): boolean {
  const rateBefore = passesOf(before) / before.length;
  const rateAfter = passesOf(after) / after.length;
  const upperAfter = wilsonBounds(passesOf(after), after.length, z).upper;
  const lowerBefore = wilsonBounds(passesOf(before), before.length, z).lower;
  return rateAfter - rateBefore + Math.sqrt((upperAfter - rateAfter) ** 2 + (rateBefore - lowerBefore) ** 2) < 0;
}

function studentT(z: number, df: number): number {
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df * df);
}

function meanDropIsSignificant(before: readonly number[], after: readonly number[], z: number): boolean {
  const difference = meanOf(before) - meanOf(after);
  const a = variance(before) / before.length;
  const b = variance(after) / after.length;
  if (a + b === 0) return difference > EPSILON;
  const df = (a + b) ** 2 / (a ** 2 / Math.max(1, before.length - 1) + b ** 2 / Math.max(1, after.length - 1));
  return difference / Math.sqrt(a + b) > studentT(z, df);
}

const binary = (values: readonly number[]): boolean => values.every((value) => value === 0 || value === 1);

/** Whether `after` sits significantly below `before`: on the pass rate (Newcombe's interval from Wilson bounds) for pass/fail values, else on the mean (Welch's t). */
export function significantDrop(before: readonly number[], after: readonly number[], z: number = ONE_SIDED_95): boolean {
  if (before.length === 0 || after.length === 0) return false;
  return binary(before) && binary(after) ? rateDropIsSignificant(before, after, z) : meanDropIsSignificant(before, after, z);
}

function windowMeans(values: readonly number[], window: number): number[] {
  return values.slice(window - 1).map((_, i) => meanOf(values.slice(i, i + window)));
}

function peakOf(means: readonly number[], gain: number): { peak: number; sinceGain: number } {
  let peak = means[0];
  let sinceGain = 0;
  for (const mean of means.slice(1)) {
    if (mean - peak >= gain - EPSILON) {
      peak = mean;
      sinceGain = 0;
    } else {
      sinceGain += 1;
    }
  }
  return { peak, sinceGain };
}

/** Paper B's trajectory gate over a series, judged on its newest window. */
export function trajectoryGate(points: readonly ScorePoint[], options: TrajectoryOptions = {}): TrajectoryVerdict {
  const { floor = 0.5, gain = 0.02, drop = 0.15, z = ONE_SIDED_95 } = options;
  const window = Math.max(1, Math.floor(options.window ?? 10));
  const values = points.map((point) => point.value);
  if (values.length < window) return { state: 'ok', ready: false, peak: meanOf(values), mean: meanOf(values), sinceGain: 0 };
  const { peak, sinceGain } = peakOf(windowMeans(values, window), gain);
  const newest = values.slice(-window);
  const mean = meanOf(newest);
  const earlier = values.slice(0, -window);
  const fell = mean < peak - drop - EPSILON && earlier.length >= window && significantDrop(earlier, newest, z);
  const state = fell ? 'regression' : sinceGain >= window && peak < floor ? 'stall' : 'ok';
  return { state, ready: true, peak, mean, sinceGain };
}

/** The Wilson score bounds on a pass rate; `z` defaults to a one-sided 95% bound. */
export function wilsonBounds(passes: number, runs: number, z: number = ONE_SIDED_95): { lower: number; upper: number } {
  if (runs <= 0) return { lower: 0, upper: 1 };
  const rate = Math.min(1, Math.max(0, passes / runs));
  const z2 = z * z;
  const scale = 1 + z2 / runs;
  const centre = (rate + z2 / (2 * runs)) / scale;
  const half = (z * Math.sqrt((rate * (1 - rate)) / runs + z2 / (4 * runs * runs))) / scale;
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

function passCubed(passes: number, runs: number): number {
  return (passes * (passes - 1) * (passes - 2)) / (runs * (runs - 1) * (runs - 2));
}

/** Windowed summary: mean, pass rate, pass^3, and one-sided 95% Wilson bounds on the pass rate. */
export function windowSummary(points: readonly ScorePoint[]): WindowStat {
  const runs = points.length;
  if (runs === 0) return { runs: 0, mean: 0, passRate: 0, lower: 0, upper: 1 };
  const values = points.map((point) => point.value);
  const passes = passesOf(values);
  return { runs, mean: meanOf(values), passRate: passes / runs, ...(runs >= 3 && { pass3: passCubed(passes, runs) }), ...wilsonBounds(passes, runs) };
}
