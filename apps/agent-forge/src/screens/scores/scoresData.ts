/**
 * Pure helpers for the Scores screen: the query-string filters, eval-level vs
 * per-check grouping of one eval's score rows, the pass-rate trend series and
 * the score -> trace deep link.
 *
 * Score names are `<evalName>` (the eval-level row each case writes: 1 iff no
 * gate failed, else 0 with the failed gates as comment) and
 * `<evalName>/<checkName>` (one per check). A row passes like the daemon's
 * aggregate counts it: no failure comment, or a perfect 1.
 */
import type { ObserveScoreRow } from '../../observe/types';
import type { TimeSeries } from '../../ui/TimeSeriesChart';
import { formatTimeRange, parseTimeRange, toWindow, type TimeRange } from '../../ui/TimeRangePicker';

/** The score sources the daemon accepts for `source=`. */
export const SCORE_SOURCES = ['eval', 'judge', 'human'] as const;

const DEFAULT_RANGE: TimeRange = { preset: '30d' };
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Windows up to this long trend by the hour, longer ones by the day. */
const HOURLY_UP_TO = 2 * DAY;
/** How many failing rows the detail lists. */
const LATEST_FAILURES = 10;

/** `?range=`: a TimeRangePicker value; missing or garbage is the 30d default. */
export const parseRange = (s: string | null): TimeRange => parseTimeRange(s) ?? DEFAULT_RANGE;
/** The default range is not written to the URL. */
export const formatRange = (r: TimeRange): string | null =>
  formatTimeRange(r) === formatTimeRange(DEFAULT_RANGE) ? null : formatTimeRange(r);

/** `?eval=a,b`: the selected eval names. */
export const parseEvals = (s: string | null): string[] => (s ? s.split(',').filter(Boolean) : []);
export const formatEvals = (v: string[]): string | null => (v.length ? v.join(',') : null);

/** A free-text param (`agent`, `open`): absent is ''. */
export const parseText = (s: string | null): string => s ?? '';
export const formatText = (v: string): string | null => v || null;

/** `?source=`: one of {@link SCORE_SOURCES}, anything else is "all". */
export const parseSource = (s: string | null): string => ((SCORE_SOURCES as readonly string[]).includes(s ?? '') ? s! : '');

/** Passed the way `?aggregate=eval` counts it. */
function isPass(row: Pick<ObserveScoreRow, 'value' | 'comment'>): boolean {
  return !row.comment || row.value === 1;
}

/** The trace screen deep link for a score (`?obs=` when it scores one step). */
export function traceHref(row: Pick<ObserveScoreRow, 'trace_id' | 'obs_id'>): string {
  const base = `#/traces/${encodeURIComponent(row.trace_id)}`;
  return row.obs_id ? `${base}?obs=${encodeURIComponent(row.obs_id)}` : base;
}

/** Pass rate, count and mean over a set of rows. */
export interface ScoreStats {
  count: number;
  passRate: number | null;
  mean: number | null;
  lastTs: number | null;
}

export function scoreStats(rows: readonly ObserveScoreRow[]): ScoreStats {
  const values = rows.flatMap((r) => (r.value === null ? [] : [r.value]));
  return {
    count: rows.length,
    passRate: rows.length ? rows.filter(isPass).length / rows.length : null,
    mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    lastTs: rows.length ? Math.max(...rows.map((r) => r.created_at)) : null,
  };
}

/** One check of an eval: its short name (after the '/') and its rows' stats. */
export interface CheckGroup extends ScoreStats {
  name: string;
  check: string;
}

/** One eval's rows split into the eval-level rows (one per case) and per-check groups (worst pass rate first). */
export interface EvalGroups {
  evalRows: ObserveScoreRow[];
  checks: CheckGroup[];
  /** Newest failing rows (eval-level or check), at most {@link LATEST_FAILURES}. */
  failures: ObserveScoreRow[];
}

export function groupEvalScores(evalName: string, rows: readonly ObserveScoreRow[]): EvalGroups {
  const evalRows: ObserveScoreRow[] = [];
  const byCheck = new Map<string, ObserveScoreRow[]>();
  for (const row of rows) {
    if (row.name === evalName) evalRows.push(row);
    else if (row.name.startsWith(`${evalName}/`)) byCheck.set(row.name, [...(byCheck.get(row.name) ?? []), row]);
  }
  const checks = [...byCheck.entries()]
    .map(([name, list]) => ({ name, check: name.slice(evalName.length + 1), ...scoreStats(list) }))
    .sort((a, b) => (a.passRate ?? 1) - (b.passRate ?? 1) || a.check.localeCompare(b.check));
  const failures = rows
    .filter((r) => !isPass(r) && (r.name === evalName || r.name.startsWith(`${evalName}/`)))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, LATEST_FAILURES);
  return { evalRows, checks, failures };
}

/** The trend chart's window: the range's bounds aligned out to whole UTC buckets (hourly up to 2 days, else daily). */
export interface TrendWindow {
  from: number;
  to: number;
  bucketMs: number;
}

export function trendWindow(range: TimeRange, now: number): TrendWindow {
  const w = toWindow(range, now);
  const bucketMs = w.to - w.from <= HOURLY_UP_TO ? HOUR : DAY;
  const from = w.from - (w.from % bucketMs);
  const to = w.to % bucketMs === 0 ? w.to : w.to - (w.to % bucketMs) + bucketMs;
  return { from, to, bucketMs };
}

/**
 * The eval's pass-rate trend from its eval-level rows: ONE point per bucket,
 * the mean value of the rows in it (TimeSeriesChart sums points that share a
 * bucket, so this pre-aggregates). Null values are skipped.
 */
export function passRateSeries(evalRows: readonly ObserveScoreRow[], w: TrendWindow): TimeSeries {
  const buckets = new Map<number, { sum: number; n: number }>();
  for (const row of evalRows) {
    if (row.value === null || row.created_at < w.from || row.created_at >= w.to) continue;
    const start = w.from + Math.floor((row.created_at - w.from) / w.bucketMs) * w.bucketMs;
    const b = buckets.get(start) ?? { sum: 0, n: 0 };
    b.sum += row.value;
    b.n += 1;
    buckets.set(start, b);
  }
  const points = [...buckets.entries()].sort(([a], [b]) => a - b).map(([t, b]) => ({ t, v: b.sum / b.n }));
  return { id: 'pass-rate', label: 'Pass rate', color: 'success', points };
}
