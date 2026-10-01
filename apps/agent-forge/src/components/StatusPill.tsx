const STATUS_LABEL: Record<string, string> = {
  idle: 'idle',
  running: 'running',
  stopped: 'stopped',
  error: 'error',
  paused: 'awaiting approval',
};

/** Run-status pill shared by the top bar and the agent cards in the left rail. */
export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`status-pill status-${status}`}>
      <span className="dot" />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
