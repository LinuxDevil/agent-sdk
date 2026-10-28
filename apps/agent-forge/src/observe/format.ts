/** Small display formatters shared by the observe panels (all epoch-ms inputs). */

/** `1_234` grouped integer, `-` for null/undefined. */
export function fmtInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return Math.round(value).toLocaleString('en-US');
}

/** A duration: `820ms`, `1.4s`, `2m 05s`. */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** USD cost: `$0.0012`, `$1.23`; `-` for null. */
export function fmtCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '-';
  if (usd === 0) return '$0';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Compact `Feb 12, 12:04` for table cells. */
export function fmtDateTime(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined) return '-';
  const d = new Date(epochMs);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${d.toTimeString().slice(0, 5)}`;
}

/** Local `15:29:30`, prefixed with `Oct 24` when the day is not `now`'s day. */
export function fmtStarted(epochMs: number, now: number = Date.now()): string {
  const d = new Date(epochMs);
  const time = d.toTimeString().slice(0, 8);
  if (d.toDateString() === new Date(now).toDateString()) return time;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`;
}

/** `3s ago` / `4m ago` / `2h ago` / `1d ago` for the fleet heartbeat column. */
export function fmtAge(ageMs: number | null | undefined): string {
  if (ageMs === null || ageMs === undefined) return 'never';
  if (ageMs < 60_000) return `${Math.max(1, Math.round(ageMs / 1000))}s ago`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
  return `${Math.round(ageMs / 86_400_000)}d ago`;
}

/** `12.5%` / `0%`; `-` for null. */
export function fmtPercent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '-';
  return `${(fraction * 100).toFixed(fraction > 0 && fraction < 0.01 ? 2 : 1)}%`;
}
