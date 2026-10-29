import './primitives.css';

/**
 * The closed set of colours a status pill can take. Each one is a
 * `pill-<tone>` class in primitives.css: `ok` success, `error` danger,
 * `warning` warning, `running` info, `neutral` muted, `violet` the LLM/agent accent.
 */
export type StatusTone = 'ok' | 'error' | 'warning' | 'running' | 'neutral' | 'violet';

const TONES = new Map<string, StatusTone>(Object.entries({
  // run
  ok: 'ok',
  error: 'error',
  running: 'running',
  interrupted: 'warning',
  // session (a thread): open, or closed by the idle sweep
  active: 'ok',
  ended: 'neutral',
  // agent
  healthy: 'ok',
  stale: 'warning',
  down: 'error',
  stopped: 'neutral',
  // score
  pass: 'ok',
  fail: 'error',
  // builder run states, and the left rail's not-yet-saved agent
  idle: 'neutral',
  done: 'ok',
  paused: 'warning',
  unsaved: 'warning',
} satisfies Record<string, StatusTone>));

const LABELS = new Map([['paused', 'awaiting approval']]);

/**
 * The tone for a status from the Studio vocabulary (run `ok|error|running|interrupted`,
 * session `active|ended`, agent `healthy|stale|down|stopped`, score `pass|fail`, builder `idle|done|paused`).
 * Anything else, including a missing status, is `neutral`.
 */
export function statusTone(status: string | null | undefined): StatusTone {
  return (status != null && TONES.get(status)) || 'neutral';
}

/**
 * The one status pill used across the Studio. Unknown statuses render their own
 * text in a neutral pill; a missing status reads "none". A `live` pill is a polite
 * `role="status"` region (the top bar's run status), so screen readers hear the
 * run start, pause and finish; its `title` repeats the label for when a short
 * toolbar shows only the dot (layout.css).
 */
export function StatusPill({ status, live = false }: { status: string | null | undefined; live?: boolean }) {
  const label = status == null ? 'none' : (LABELS.get(status) ?? status);
  return (
    <span
      className={`status-pill pill-${statusTone(status)}`}
      role={live ? 'status' : undefined}
      aria-live={live ? 'polite' : undefined}
      title={live ? label : undefined}
    >
      <span className="dot" aria-hidden="true" />
      {live && <span className="visually-hidden">Run status: </span>}
      <span className="status-pill-label">{label}</span>
    </span>
  );
}
