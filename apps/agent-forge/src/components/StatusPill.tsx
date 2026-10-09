const STATUS_LABEL: Record<string, string> = {
  idle: 'idle',
  running: 'running',
  stopped: 'stopped',
  error: 'error',
  paused: 'awaiting approval',
};

/**
 * Run-status pill shared by the top bar and the agent cards in the left rail.
 * Eve DUI-F9: the top bar's pill is `live` - a polite `role="status"` region,
 * so screen readers hear the run start, pause and finish.
 */
export function StatusPill({ status, live = false }: { status: string; live?: boolean }) {
  const label = STATUS_LABEL[status] ?? status;
  return (
    <span
      className={`status-pill status-${status}`}
      role={live ? 'status' : undefined}
      aria-live={live ? 'polite' : undefined}
    >
      <span className="dot" aria-hidden="true" />
      {live && <span className="visually-hidden">Run status: </span>}
      {label}
    </span>
  );
}
