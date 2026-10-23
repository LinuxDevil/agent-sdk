/** Shared bits of the observe panels' chrome: the daemon-down empty state, inline API errors, status pills. */

/**
 * The "daemon not running" state every panel shares: the hint is the
 * command, not a dead error, and the health probe keeps polling so the
 * panels swap in by themselves once `lousho observe start` runs.
 */
export function ObserveDaemonDown() {
  return (
    <div className="observe-empty" role="status">
      <p className="observe-empty-title">No data yet - the observe daemon is not reachable.</p>
      <p>
        Run <code>lousho observe start</code>, then set <code>LOUSHO_OBSERVE=1</code> on your agents; their traces,
        scores and heartbeats show up here automatically.
      </p>
    </div>
  );
}

/** An API failure that is not "daemon down" (a 400/404/500 answer) - shown inline so the panel chrome stays put. */
export function ObserveError({ error }: { error: Error | undefined }) {
  if (!error) return null;
  return (
    <div className="observe-error" role="alert">
      {error.message}
    </div>
  );
}

/** `ok`/`error`/`interrupted`/`healthy`/… -> the status-pill colour classes shared with the rest of the app. */
export function statusClass(status: string | null | undefined): string {
  switch (status) {
    case 'ok':
    case 'healthy':
      return 'status-ok';
    case 'error':
    case 'down':
      return 'status-error';
    case 'interrupted':
    case 'stale':
      return 'status-interrupted';
    case 'running':
      return 'status-running';
    default:
      return 'status-idle';
  }
}

export function ObserveStatusPill({ status }: { status: string | null | undefined }) {
  const label = status ?? 'unknown';
  return (
    <span className={`status-pill ${statusClass(status)}`}>
      <span className="dot" aria-hidden="true" />
      {label}
    </span>
  );
}
