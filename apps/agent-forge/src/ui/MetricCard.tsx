import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { Skeleton } from './Skeleton';
import './metricCard.css';

/** A change against a comparison window, shown under the value. */
interface MetricDelta {
  /** Signed change: positive is up, negative down, 0 no change. */
  value: number;
  /** Formats the magnitude (`Math.abs(value)`); the arrow and phrase carry the direction. Default `12%`. */
  format?: (v: number) => string;
  /** Which direction is good news (default `'up'`; `'down'` for errors, latency, cost). */
  goodWhen?: 'up' | 'down';
  /** The comparison, read after the change (default `'vs previous window'`). */
  label?: string;
}

/** Props for {@link MetricCard}. */
interface MetricCardProps {
  /** Overline label ("Runs", "p95 latency"). */
  label: string;
  /** The metric, already formatted. */
  value: ReactNode;
  delta?: MetricDelta;
  /** Recent values, oldest first, drawn as a tiny line; fewer than two points draw nothing. */
  sparkline?: number[];
  /** Muted line under the value ("last 24 h"). */
  hint?: ReactNode;
  /** Skeletons in place of the value, delta and sparkline. */
  loading?: boolean;
}

const percent = (v: number) => `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;

/** good = success, bad = danger, neutral = muted (no change). */
function toneOf(value: number, goodWhen: 'up' | 'down'): 'good' | 'bad' | 'neutral' {
  if (value === 0) return 'neutral';
  return value > 0 === (goodWhen === 'up') ? 'good' : 'bad';
}

function Delta({ value, format = percent, goodWhen = 'up', label = 'vs previous window' }: MetricDelta) {
  const shown = format(Math.abs(value));
  const Icon = value > 0 ? ArrowUp : value < 0 ? ArrowDown : Minus;
  const spoken = value === 0 ? `no change ${label}` : `${value > 0 ? 'up' : 'down'} ${shown} ${label}`;
  return (
    <span className="metric-delta" data-tone={toneOf(value, goodWhen)}>
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
      <span aria-hidden="true">{shown}</span>
      <span className="visually-hidden">{spoken}</span>
    </span>
  );
}

const SPARK_W = 96;
const SPARK_H = 32;

/** `points` for an SVG polyline spanning SPARK_W x SPARK_H (a flat series sits mid-height). */
function sparkPoints(values: number[]): string {
  const min = Math.min(...values);
  const span = Math.max(...values) - min;
  const step = SPARK_W / (values.length - 1);
  return values
    .map((v, i) => {
      const y = span === 0 ? SPARK_H / 2 : SPARK_H - 2 - ((v - min) / span) * (SPARK_H - 4);
      return `${(i * step).toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function Sparkline({ values }: { values: number[] }) {
  return (
    <svg
      className="metric-sparkline"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <polyline points={sparkPoints(values)} />
    </svg>
  );
}

/** One KPI tile: overline label, a 24px tabular value, optional delta, hint and sparkline. */
export function MetricCard({ label, value, delta, sparkline, hint, loading }: MetricCardProps) {
  const showDelta = delta !== undefined && !loading;
  return (
    <div className="metric-card" aria-busy={loading ? true : undefined}>
      <div className="metric-main">
        <span className="metric-label overline">{label}</span>
        <span className="metric-value tabular-nums">
          {loading ? (
            <>
              <span className="visually-hidden">Loading</span>
              <Skeleton width={72} height={22} />
            </>
          ) : (
            value
          )}
        </span>
        {(showDelta || hint != null) && (
          <span className="metric-meta">
            {showDelta && <Delta {...delta} />}
            {hint != null && <span className="metric-hint">{hint}</span>}
          </span>
        )}
      </div>
      {sparkline && sparkline.length >= 2 && !loading && <Sparkline values={sparkline} />}
      {sparkline && loading && <Skeleton className="metric-spark-skeleton" width={SPARK_W} height={SPARK_H} />}
    </div>
  );
}
