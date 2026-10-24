/**
 * Pure query-string helpers shared by the list screens' URL state
 * (`traces/tracesUrl.ts`, `threads/threadsUrl.ts`).
 */

/** A non-negative integer query value, or `undefined` when missing or malformed. */
export const toInt = (s: string | null): number | undefined => (s !== null && /^\d+$/.test(s) ? Number(s) : undefined);

/** An absolute `from`/`to` window (ms epoch, half-open); dropped unless both are present and `from < to`. */
export function parseWindow(query: URLSearchParams): { from: number; to: number } | undefined {
  const from = toInt(query.get('from'));
  const to = toInt(query.get('to'));
  return from !== undefined && to !== undefined && from < to ? { from, to } : undefined;
}

/** Write a window (when set) as `from` + `to`. */
export function writeWindow(params: URLSearchParams, window: { from: number; to: number } | undefined): void {
  if (!window) return;
  params.set('from', String(window.from));
  params.set('to', String(window.to));
}
