import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import './timeSeriesChart.css';

/** The token a series is drawn in; each maps to the `var(--<color>)` theme variable. */
export type SeriesColor = 'accent' | 'danger' | 'success' | 'warning' | 'info';

/** One sample: `t` is epoch ms, `v` the value. */
export interface TimeSeriesPoint {
  t: number;
  v: number;
}

/** One line on a {@link TimeSeriesChart}. */
export interface TimeSeries {
  id: string;
  label: string;
  color: SeriesColor;
  points: TimeSeriesPoint[];
}

/** Props for {@link TimeSeriesChart}. */
export interface TimeSeriesChartProps {
  series: TimeSeries[];
  /** Start of the window (epoch ms); the first bucket starts here. */
  from: number;
  /** End of the window (epoch ms, exclusive). */
  to: number;
  /** Bucket width in ms; bucket starts are `from + k * bucketMs` while `< to`. */
  bucketMs: number;
  /** Formats y tick labels and tooltip values. */
  yFormat: (v: number) => string;
  /** Called with a bucket's `[start, end)` when it is clicked (or Enter while focused). */
  onBucketClick?: (from: number, to: number) => void;
  /** Chart height in px (default 200). */
  height?: number;
}

const PAD = { l: 48, r: 12, t: 8, b: 22 };
const DEFAULT_WIDTH = 600;
const MAX_X_LABELS = 8;
const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Per bucket: the summed value of the points in it, or undefined when it has none. */
type Buckets = (number | undefined)[];

const pad2 = (n: number) => String(n).padStart(2, '0');

function formatTime(t: number, multiDay: boolean): string {
  const d = new Date(t);
  return multiDay ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function bucketCount(from: number, to: number, bucketMs: number): number {
  if (!(bucketMs > 0) || !(to > from)) return 1;
  return Math.max(1, Math.ceil((to - from) / bucketMs));
}

function bucketize(points: TimeSeriesPoint[], from: number, bucketMs: number, n: number): Buckets {
  const out: Buckets = new Array<number | undefined>(n).fill(undefined);
  for (const p of points) {
    const k = Math.floor((p.t - from) / bucketMs);
    if (k >= 0 && k < n) out[k] = (out[k] ?? 0) + p.v;
  }
  return out;
}

/** Runs of consecutive present buckets: each is a polyline, or a single point when it has one bucket. */
function segments(values: Buckets): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  values.forEach((v, k) => {
    if (v === undefined) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push(k);
  });
  if (run.length) runs.push(run);
  return runs;
}

/** Smallest 1/2/5 x 10^n step that is >= raw. */
function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
}

const clean = (v: number) => Number(v.toPrecision(12));

/** Nice y ticks covering [min(0, lo), max(0, hi)]; the first and last tick are the domain. */
function yTicks(values: Buckets[]): number[] {
  const all = values.flat().filter((v): v is number => v !== undefined && Number.isFinite(v));
  const lo = Math.min(0, ...all);
  let hi = Math.max(0, ...all);
  if (hi === lo) hi = lo + 1;
  const step = niceStep((hi - lo) / 4);
  const start = Math.floor(lo / step);
  const end = Math.ceil(hi / step);
  const ticks: number[] = [];
  for (let i = start; i <= end; i++) ticks.push(clean(i * step));
  return ticks;
}

/** Boundary indices 0..n to label: every `step`th, at most MAX_X_LABELS of them. */
function xTickIndices(n: number): number[] {
  const step = Math.ceil((n + 1) / MAX_X_LABELS);
  const out: number[] = [];
  for (let k = 0; k <= n; k += step) out.push(k);
  return out;
}

/** Container width via ResizeObserver; DEFAULT_WIDTH where it is unavailable (jsdom) or reports 0. */
function useWidth(ref: RefObject<HTMLDivElement>): number {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useLayoutEffect(() => {
    const el = ref.current;
    if (typeof ResizeObserver === 'undefined' || !el) return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1]?.contentRect.width;
      if (w) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** Geometry shared by every part of one render. */
interface Layout {
  n: number;
  plotW: number;
  plotH: number;
  bw: number;
  lo: number;
  hi: number;
}

const xAt = (L: Layout, boundary: number) => PAD.l + boundary * L.bw;
const cx = (L: Layout, k: number) => PAD.l + (k + 0.5) * L.bw;
const yAt = (L: Layout, v: number) => PAD.t + L.plotH - ((v - L.lo) / (L.hi - L.lo)) * L.plotH;

function SeriesMarks({ s, values, L }: { s: TimeSeries; values: Buckets; L: Layout }) {
  const stroke = `var(--${s.color})`;
  return (
    <g>
      {segments(values).map((run) =>
        run.length === 1 ? (
          <circle
            key={run[0]}
            className="tsc-point"
            data-series={s.id}
            cx={cx(L, run[0]!)}
            cy={yAt(L, values[run[0]!]!)}
            r={3}
            fill={stroke}
          />
        ) : (
          <polyline
            key={run[0]}
            className="tsc-line"
            data-series={s.id}
            points={run.map((k) => `${cx(L, k)},${yAt(L, values[k]!)}`).join(' ')}
            stroke={stroke}
            fill="none"
          />
        ),
      )}
    </g>
  );
}

function Axes({ L, ticks, xs, from, bucketMs, multiDay, yFormat }: {
  L: Layout;
  ticks: number[];
  xs: number[];
  from: number;
  bucketMs: number;
  multiDay: boolean;
  yFormat: (v: number) => string;
}) {
  const bottom = PAD.t + L.plotH;
  return (
    <g aria-hidden="true">
      {ticks.map((v) => (
        <g key={v}>
          <line className="tsc-grid" x1={PAD.l} x2={PAD.l + L.plotW} y1={yAt(L, v)} y2={yAt(L, v)} />
          <text className="tsc-ytick" data-v={v} x={PAD.l - 6} y={yAt(L, v)} textAnchor="end" dominantBaseline="middle">
            {yFormat(v)}
          </text>
        </g>
      ))}
      {xs.map((k) => (
        <g key={k}>
          <line className="tsc-axis" x1={xAt(L, k)} x2={xAt(L, k)} y1={bottom} y2={bottom + 4} />
          <text className="tsc-xtick" data-t={from + k * bucketMs} x={xAt(L, k)} y={bottom + 16} textAnchor="middle">
            {formatTime(from + k * bucketMs, multiDay)}
          </text>
        </g>
      ))}
    </g>
  );
}

function Tooltip({ k, x, series, values, from, bucketMs, multiDay, yFormat }: {
  k: number | null;
  x: number;
  series: TimeSeries[];
  values: Buckets[];
  from: number;
  bucketMs: number;
  multiDay: boolean;
  yFormat: (v: number) => string;
}) {
  const start = from + (k ?? 0) * bucketMs;
  return (
    <div className="tsc-tooltip" role="status" aria-live="polite" style={{ left: `${x}px` }}>
      {k !== null && (
        <>
          <div className="tsc-tip-time">
            {formatTime(start, multiDay)} – {formatTime(start + bucketMs, multiDay)}
          </div>
          {series.map((s, i) => {
            const v = values[i]![k];
            return (
              <div key={s.id} className="tsc-tip-row">
                <span className="tsc-swatch" style={{ background: `var(--${s.color})` }} aria-hidden="true" />
                <span className="tsc-tip-label">{s.label}</span>
                <span className="tsc-tip-value">{v === undefined ? '—' : yFormat(v)}</span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function Legend({ series }: { series: TimeSeries[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="tsc-legend">
      {series.map((s) => (
        <li key={s.id}>
          <span className="tsc-swatch" style={{ background: `var(--${s.color})` }} aria-hidden="true" />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/** Hovered bucket plus the pointer, keyboard and click handlers that drive it. */
function useBucketHover(n: number, L: Layout, onPick: (k: number) => void) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const width = PAD.l + L.plotW + PAD.r;

  const bucketAt = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const scale = rect?.width ? width / rect.width : 1;
    const x = (clientX - (rect?.left ?? 0)) * scale;
    return Math.min(n - 1, Math.max(0, Math.floor((x - PAD.l) / L.bw)));
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowRight') setHover((h) => (h === null ? 0 : Math.min(n - 1, h + 1)));
    else if (e.key === 'ArrowLeft') setHover((h) => (h === null ? n - 1 : Math.max(0, h - 1)));
    else if (e.key === 'Escape') setHover(null);
    else if (e.key === 'Enter' && hover !== null) onPick(hover);
    else return;
    e.preventDefault();
  };
  return {
    hover,
    svgRef,
    onKeyDown,
    onPointerMove: (e: ReactPointerEvent) => setHover(bucketAt(e.clientX)),
    onPointerLeave: () => setHover(null),
    onClick: (e: { clientX: number }) => onPick(bucketAt(e.clientX)),
  };
}

/**
 * A hand-rolled SVG line chart over fixed time buckets (`from + k * bucketMs`).
 *
 * - Width follows the container via ResizeObserver (600 px where it is unavailable),
 *   drawn at real pixel size so text never stretches; `height` is fixed (default 200).
 * - Points are bucketed by `floor((t - from) / bucketMs)` and summed per bucket. Missing
 *   buckets are gaps: each run of present buckets is a polyline through bucket centres,
 *   and a run of one bucket is a single point.
 * - Y ticks are nice 1/2/5 x 10^n steps from 0 (or the minimum, if negative) to at least
 *   the maximum; empty or all-zero data reads 0..1. X labels sit on bucket boundaries
 *   (at most 8), HH:MM for sub-day windows and "MMM D" for longer ones, local time.
 * - Hover or Left/Right (the plot is focusable) shows a crosshair and a polite status
 *   tooltip with every series' value ("—" when absent); click or Enter calls
 *   `onBucketClick(start, start + bucketMs)`. Escape or leaving clears it.
 */
export function TimeSeriesChart({ series, from, to, bucketMs, yFormat, onBucketClick, height = 200 }: TimeSeriesChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useWidth(wrapRef);
  const n = bucketCount(from, to, bucketMs);
  const values = series.map((s) => bucketize(s.points, from, bucketMs, n));
  const ticks = yTicks(values);
  const plotW = Math.max(1, width - PAD.l - PAD.r);
  const L: Layout = {
    n,
    plotW,
    plotH: Math.max(1, height - PAD.t - PAD.b),
    bw: plotW / n,
    lo: ticks[0]!,
    hi: ticks[ticks.length - 1]!,
  };
  const multiDay = to - from >= DAY;
  const pick = (k: number) => onBucketClick?.(from + k * bucketMs, from + (k + 1) * bucketMs);
  const h = useBucketHover(n, L, pick);
  const label =
    `Time series chart: ${series.map((s) => s.label).join(', ') || 'no series'}; ` +
    `${n} buckets from ${formatTime(from, multiDay)} to ${formatTime(from + n * bucketMs, multiDay)}`;

  return (
    <div className="tsc" ref={wrapRef}>
      <svg
        ref={h.svgRef}
        className="tsc-svg"
        role="img"
        aria-label={label}
        tabIndex={0}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onKeyDown={h.onKeyDown}
        onBlur={h.onPointerLeave}
      >
        <Axes L={L} ticks={ticks} xs={xTickIndices(n)} from={from} bucketMs={bucketMs} multiDay={multiDay} yFormat={yFormat} />
        {series.map((s, i) => (
          <SeriesMarks key={s.id} s={s} values={values[i]!} L={L} />
        ))}
        {h.hover !== null && (
          <line className="tsc-crosshair" x1={cx(L, h.hover)} x2={cx(L, h.hover)} y1={PAD.t} y2={PAD.t + L.plotH} />
        )}
        <rect
          className={`tsc-plot${onBucketClick ? ' tsc-clickable' : ''}`}
          x={PAD.l}
          y={PAD.t}
          width={L.plotW}
          height={L.plotH}
          onPointerMove={h.onPointerMove}
          onPointerLeave={h.onPointerLeave}
          onClick={h.onClick}
        />
      </svg>
      <Tooltip
        k={h.hover}
        x={h.hover === null ? 0 : cx(L, h.hover)}
        series={series}
        values={values}
        from={from}
        bucketMs={bucketMs}
        multiDay={multiDay}
        yFormat={yFormat}
      />
      <Legend series={series} />
    </div>
  );
}
