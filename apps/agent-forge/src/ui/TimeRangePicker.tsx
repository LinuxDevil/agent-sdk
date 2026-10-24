import { useEffect, useState } from 'react';
import './filterBar.css';

/** Preset window names, shortest first. */
const PRESETS = ['15m', '1h', '24h', '7d', '30d'] as const;
type Preset = (typeof PRESETS)[number];

const PRESET_MS: Record<Preset, number> = {
  '15m': 900_000,
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
};

/** A time range: a rolling preset ending "now", or an absolute window in epoch milliseconds. */
export type TimeRange = { preset: Preset } | { from: number; to: number };

/** Resolve a range to concrete epoch-millisecond bounds; an absolute range is returned unchanged. */
export function toWindow(r: TimeRange, now: number): { from: number; to: number } {
  if ('preset' in r) return { from: now - PRESET_MS[r.preset], to: now };
  return r;
}

/** Parse a query-string value ('24h' or '<fromMs>-<toMs>') into a range; garbage yields null. */
export function parseTimeRange(s: string | null): TimeRange | null {
  if (s == null) return null;
  if ((PRESETS as readonly string[]).includes(s)) return { preset: s as Preset };
  const m = /^(\d+)-(\d+)$/.exec(s);
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  return from < to ? { from, to } : null;
}

/** Serialise a range for one query key: the preset name, or '<fromMs>-<toMs>'. */
export function formatTimeRange(r: TimeRange): string {
  return 'preset' in r ? r.preset : `${r.from}-${r.to}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Epoch ms to the `YYYY-MM-DDTHH:mm` local string a datetime-local input expects. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fromLocalInput = (s: string): number => (s ? new Date(s).getTime() : NaN);

/** Props for {@link TimeRangePicker}. */
interface TimeRangePickerProps {
  value: TimeRange;
  onChange: (next: TimeRange) => void;
}

/** Controlled range picker: five preset buttons plus "Custom" with two datetime-local inputs and an Apply button. */
export function TimeRangePicker({ value, onChange }: TimeRangePickerProps) {
  const absolute = !('preset' in value);
  const key = formatTimeRange(value);
  const [customOpen, setCustomOpen] = useState(absolute);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Seed (and re-seed on any external change of `value`) the custom inputs and open state.
  useEffect(() => {
    const w = toWindow(value, Date.now());
    setFrom(toLocalInput(w.from));
    setTo(toLocalInput(w.to));
    setCustomOpen(!('preset' in value));
  }, [key]);
  const fromMs = fromLocalInput(from);
  const toMs = fromLocalInput(to);
  const valid = Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs < toMs;

  return (
    <div className="time-range" role="group" aria-label="Time range">
      {PRESETS.map((p) => (
        <button
          key={p}
          type="button"
          className="seg-btn"
          aria-pressed={!absolute && value.preset === p}
          onClick={() => {
            setCustomOpen(false);
            onChange({ preset: p });
          }}
        >
          {p}
        </button>
      ))}
      <button
        type="button"
        className="seg-btn"
        aria-pressed={absolute}
        aria-expanded={customOpen}
        onClick={() => setCustomOpen((o) => !o)}
      >
        Custom
      </button>
      {customOpen && (
        <div className="time-range-custom">
          <label>
            From
            <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            To
            <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button
            type="button"
            className="seg-btn"
            disabled={!valid}
            onClick={() => onChange({ from: fromMs, to: toMs })}
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
