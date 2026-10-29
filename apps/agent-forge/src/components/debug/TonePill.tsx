import { statusTone, type StatusTone } from '../../ui/StatusPill';

/**
 * A status pill in an explicit tone, for the drawer's own vocabularies (log
 * levels, checkpoint statuses) that StatusPill's status map does not know.
 * Same markup as StatusPill, so the label is drawn in sentence case too.
 */
export function TonePill({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span className={`status-pill pill-${tone}`}>
      <span className="dot" aria-hidden="true" />
      <span className="status-pill-label">{label}</span>
    </span>
  );
}

/** A checkpoint step's tone: finished ok, in-progress running, else the shared status vocabulary. */
export function stepTone(status: string): StatusTone {
  if (status === 'finished') return 'ok';
  if (status === 'in-progress') return 'running';
  if (status === 'failed') return 'error';
  return statusTone(status);
}
