import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import './timeSeriesChart.css';

/**
 * The token a series is drawn in; each maps to the `var(--<color>)` theme variable.
 * The semantic ones suit status series (OK / Error); `chart-1`..`chart-6` are the
 * categorical palette for everything else (per agent, per model).
 */
export type SeriesColor =
  | 'accent'
  | 'danger'
  | 'success'
  | 'warning'
  | 'info'
  | 'chart-1'
  | 'chart-2'
  | 'chart-3'
  | 'chart-4'
  | 'chart-5'
  | 'chart-6';

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
  /** Fill a gradient (the series colour at 18% fading to 0) under each line (default true). */
  area?: boolean;
  /**
   * Show the legend: pill chips with `aria-pressed` that hide or show their series
   * (the last visible one cannot be hidden). Default: only when there is more than one series.
   */
  legend?: boolean;
}

const PAD = { l: 48, r: 12, t: 8, b: 22 };
/** Top opacity of the area gradient under a line. */
const AREA_OPACITY = 0.18;
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

/** The geometry for `n` buckets in a `width` x `height` box; the y domain is the first..last tick. */
function layout(n: number, width: number, height: number, ticks: number[]): Layout {
  const plotW = Math.max(1, width - PAD.l - PAD.r);
  return {
    n,
    plotW,
    plotH: Math.max(1, height - PAD.t - PAD.b),
    bw: plotW / n,
    lo: ticks[0]!,
    hi: ticks[ticks.length - 1]!,
  };
}

const xAt = (L: Layout, boundary: number) => PAD.l + boundary * L.bw;
const cx = (L: Layout, k: number) => PAD.l + (k + 0.5) * L.bw;
const yAt = (L: Layout, v: number) => PAD.t + L.plotH - ((v - L.lo) / (L.hi - L.lo)) * L.plotH;

const colorVar = (s: TimeSeries) => `var(--${s.color})`;

/** The plot's floor for area fills: y = 0, clamped into the domain. */
const floorY = (L: Layout) => yAt(L, Math.min(Math.max(0, L.lo), L.hi));

function SeriesMarks({ s, values, L }: { s: TimeSeries; values: Buckets; L: Layout }) {
  const stroke = colorVar(s);
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

/** One vertical gradient per series: its colour at {@link AREA_OPACITY} at the top, transparent at the floor. */
function AreaGradients({ series, idOf }: { series: TimeSeries[]; idOf: (s: TimeSeries) => string }) {
  return (
    <defs>
      {series.map((s) => (
        <linearGradient key={s.id} id={idOf(s)} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: colorVar(s), stopOpacity: AREA_OPACITY }} />
          <stop offset="1" style={{ stopColor: colorVar(s), stopOpacity: 0 }} />
        </linearGradient>
      ))}
    </defs>
  );
}

/** The filled area under each run of two or more buckets (a lone point gets none). */
function SeriesArea({ s, values, L, fill }: { s: TimeSeries; values: Buckets; L: Layout; fill: string }) {
  const floor = floorY(L);
  return (
    <g aria-hidden="true">
      {segments(values)
        .filter((run) => run.length > 1)
        .map((run) => {
          const top = run.map((k) => `${cx(L, k)},${yAt(L, values[k]!)}`).join(' L');
          const d = `M${top} L${cx(L, run[run.length - 1]!)},${floor} L${cx(L, run[0]!)},${floor} Z`;
          return <path key={run[0]} className="tsc-area" data-series={s.id} d={d} fill={`url(#${fill})`} />;
        })}
    </g>
  );
}

/** The crosshair at the hovered bucket plus a ringed dot on every series that has a value there. */
function Crosshair({ k, L, series, values }: { k: number; L: Layout; series: TimeSeries[]; values: Buckets[] }) {
  const x = cx(L, k);
  return (
    <g aria-hidden="true">
      <line className="tsc-crosshair" x1={x} x2={x} y1={PAD.t} y2={PAD.t + L.plotH} />
      {series.map((s, i) => {
        const v = values[i]![k];
        return v === undefined ? null : <circle key={s.id} className="tsc-hover-dot" cx={x} cy={yAt(L, v)} r={4} fill={colorVar(s)} />;
      })}
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

function Tooltip({ k, x, flip, series, values, from, bucketMs, multiDay, yFormat }: {
  k: number | null;
  x: number;
  /** Open to the left of the crosshair (it sits in the right half of the plot). */
  flip: boolean;
  series: TimeSeries[];
  values: Buckets[];
  from: number;
  bucketMs: number;
  multiDay: boolean;
  yFormat: (v: number) => string;
}) {
  const start = from + (k ?? 0) * bucketMs;
  return (
    <div className={`tsc-tooltip${flip ? ' tsc-tooltip-left' : ''}`} role="status" aria-live="polite" style={{ left: `${x}px` }}>
      {k !== null && (
        <>
          <div className="tsc-tip-time">
            {formatTime(start, multiDay)} – {formatTime(start + bucketMs, multiDay)}
          </div>
          {series.map((s, i) => {
            const v = values[i]![k];
            return (
              <div key={s.id} className="tsc-tip-row">
                <span className="tsc-tip-dot" style={{ background: colorVar(s) }} aria-hidden="true" />
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

/** Every visible series: its area fill (with the gradients it references) under its line or points. */
function Plot({ series, values, L, area, idOf }: {
  series: TimeSeries[];
  values: Buckets[];
  L: Layout;
  area: boolean;
  idOf: (s: TimeSeries) => string;
}) {
  return (
    <>
      {area && <AreaGradients series={series} idOf={idOf} />}
      {area && series.map((s, i) => <SeriesArea key={s.id} s={s} values={values[i]!} L={L} fill={idOf(s)} />)}
      {series.map((s, i) => (
        <SeriesMarks key={s.id} s={s} values={values[i]!} L={L} />
      ))}
    </>
  );
}

/** Pill chips that hide or show their series; the last visible series stays on (its chip is disabled). */
function Legend({ series, hidden, onToggle }: { series: TimeSeries[]; hidden: ReadonlySet<string>; onToggle: (id: string) => void }) {
  const visibleCount = series.filter((s) => !hidden.has(s.id)).length;
  return (
    <ul className="tsc-legend" aria-label="Series">
      {series.map((s) => {
        const on = !hidden.has(s.id);
        return (
          <li key={s.id}>
            <button type="button" className="tsc-chip" aria-pressed={on} disabled={on && visibleCount === 1} onClick={() => onToggle(s.id)}>
              <span className="tsc-swatch" style={on ? { background: colorVar(s) } : undefined} aria-hidden="true" />
              {s.label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Which series the legend has hidden. Ids no longer in `series` are ignored; if nothing is left visible, all are. */
function useHiddenSeries(series: TimeSeries[]) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const visible = series.filter((s) => !hidden.has(s.id));
  const toggle = (id: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (series.some((s) => s.id !== id && !next.has(s.id))) next.add(id);
      return next;
    });
  return { hidden, visible: visible.length ? visible : series, toggle };
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
 *   buckets are gaps: each run of present buckets is a polyline through bucket centres
 *   over a gradient area fill (`area`, default on), and a run of one bucket is a single point.
 * - Y ticks are nice 1/2/5 x 10^n steps from 0 (or the minimum, if negative) to at least
 *   the maximum of the visible series; empty or all-zero data reads 0..1. X labels sit on
 *   bucket boundaries (at most 8), HH:MM for sub-day windows and "MMM D" for longer ones, local time.
 * - Hover or Left/Right (the plot is focusable) shows a crosshair and a polite status
 *   tooltip with every visible series' value ("—" when absent); click or Enter calls
 *   `onBucketClick(start, start + bucketMs)`. Escape or leaving clears it.
 * - The legend (`legend`, default: more than one series) is a row of `aria-pressed` chips
 *   that hide or show a series; at least one series always stays visible.
 */
export function TimeSeriesChart({
  series,
  from,
  to,
  bucketMs,
  yFormat,
  onBucketClick,
  height = 200,
  area = true,
  legend = series.length > 1,
}: TimeSeriesChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useWidth(wrapRef);
  // useId's colons would need escaping inside url(#…).
  const idBase = useId().replace(/:/g, '');
  const { hidden, visible, toggle } = useHiddenSeries(series);
  const n = bucketCount(from, to, bucketMs);
  const values = visible.map((s) => bucketize(s.points, from, bucketMs, n));
  const ticks = yTicks(values);
  const L = layout(n, width, height, ticks);
  const multiDay = to - from >= DAY;
  const pick = (k: number) => onBucketClick?.(from + k * bucketMs, from + (k + 1) * bucketMs);
  const h = useBucketHover(n, L, pick);
  const gradientId = (s: TimeSeries) => `${idBase}-area-${series.indexOf(s)}`;
  const hoverX = h.hover === null ? 0 : cx(L, h.hover);
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
        <Plot series={visible} values={values} L={L} area={area} idOf={gradientId} />
        {h.hover !== null && <Crosshair k={h.hover} L={L} series={visible} values={values} />}
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
        x={hoverX}
        flip={hoverX > PAD.l + L.plotW / 2}
        series={visible}
        values={values}
        from={from}
        bucketMs={bucketMs}
        multiDay={multiDay}
        yFormat={yFormat}
      />
      {legend && <Legend series={series} hidden={hidden} onToggle={toggle} />}
    </div>
  );
}
