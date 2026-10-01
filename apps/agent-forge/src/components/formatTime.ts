/** Local HH:MM:SS for an ISO timestamp, or '' when it doesn't parse. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8);
}
