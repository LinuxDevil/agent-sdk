import './status.css';
import './toolCallRow.css';

import { useId, useState, type ReactNode } from 'react';
import { ChevronRight, Wrench, type LucideIcon } from 'lucide-react';

import { formatTime } from '../components/formatTime';
import { fmtDuration } from '../observe/format';

import { STATUS_CONFIG } from './status';

/**
 * The lifecycle states a single tool call row can show. `waiting` means the
 * call is paused on human input or approval; `interrupted` means it was
 * aborted before producing a result.
 */
export type ToolCallState = 'running' | 'done' | 'error' | 'interrupted' | 'waiting';

/** Props for {@link ToolCallRow}. */
export interface ToolCallRowProps {
  /** Tool name as the run recorded it, e.g. 'web-fetch' or 'github_create_issue'. */
  name: string;
  /** MCP server key, shown as a small mono badge before the name. */
  server?: string;
  /** One-line input summary (a URL, a query); truncated, full text in `title`. */
  summary?: string;
  state: ToolCallState;
  /** Call duration; rendered with `fmtDuration` when defined. */
  durationMs?: number;
  /** ISO start time; rendered as local HH:MM:SS in a `<time>` element. */
  at?: string;
  /** Right-side buttons (Approve anyway, Open spans) - outside the toggle button. */
  actions?: ReactNode;
  defaultOpen?: boolean;
  /** Called with the next open state after every expand/collapse. */
  onToggle?(open: boolean): void;
  /** The expanded renderer; without children the row cannot expand. */
  children?: ReactNode;
}

/**
 * One row's icon and spoken state word. Icons and labels come from
 * {@link STATUS_CONFIG} so a call's look matches badges and dots, except a
 * finished call gets a `Wrench` (a result is not a status highlight) and
 * `interrupted` reads as itself rather than 'Stopped'.
 */
const TOOL_CALL_STATE: Record<ToolCallState, { icon: LucideIcon; srLabel: string }> = {
  running: { icon: STATUS_CONFIG.running.icon, srLabel: STATUS_CONFIG.running.label },
  done: { icon: Wrench, srLabel: STATUS_CONFIG.done.label },
  error: { icon: STATUS_CONFIG.error.icon, srLabel: STATUS_CONFIG.error.label },
  interrupted: { icon: STATUS_CONFIG.stopped.icon, srLabel: 'Interrupted' },
  waiting: { icon: STATUS_CONFIG.waiting.icon, srLabel: STATUS_CONFIG.waiting.label },
};

interface ToggleProps {
  state: ToolCallState;
  name: string;
  server?: string;
  summary?: string;
  durationMs?: number;
  /** ISO timestamp and its formatted HH:MM:SS ('' when missing or unparseable). */
  at?: string;
  atTime: string;
  expandable: boolean;
  open: boolean;
  bodyId: string;
  onToggle(): void;
}

/**
 * The toggle button filling the row head: state icon, visually-hidden state
 * word, optional server badge, name, truncated summary, duration/time meta and
 * the chevron. With no `children` on the row it renders disabled and carries
 * no expand semantics.
 */
function ToolCallToggle({
  state,
  name,
  server,
  summary,
  durationMs,
  at,
  atTime,
  expandable,
  open,
  bodyId,
  onToggle,
}: ToggleProps): JSX.Element {
  const { icon: Icon, srLabel } = TOOL_CALL_STATE[state];
  return (
    <button
      type="button"
      className="tool-call-toggle"
      aria-expanded={expandable ? open : undefined}
      aria-controls={expandable ? bodyId : undefined}
      disabled={!expandable}
      onClick={onToggle}
    >
      <span className="tool-call-icon">
        <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <span className="visually-hidden">{`${srLabel}: `}</span>
      {server != null && (
        <span className="tool-call-server" title={`MCP server ${server}`}>
          {server}
        </span>
      )}
      <span className="tool-call-name">{name}</span>
      {summary != null && (
        <span className="tool-call-summary" title={summary}>
          {summary}
        </span>
      )}
      <span className="tool-call-meta">
        {durationMs !== undefined && <span className="tabular-nums">{fmtDuration(durationMs)}</span>}
        {atTime !== '' && <time dateTime={at}>{atTime}</time>}
      </span>
      {expandable && <ChevronRight size={14} strokeWidth={1.75} className="tool-call-chevron" aria-hidden="true" />}
    </button>
  );
}

/**
 * One tool call as a single quiet line - state icon, optional MCP server badge,
 * tool name, one-line input summary, duration and time - that expands to show
 * whatever renderer the caller passes as `children` (run output, trace spans).
 * Error rows get a danger-tinted border, interrupted and waiting rows a
 * warning-tinted one. The row is uncontrolled (`defaultOpen` seeds it) and the
 * state word before the name is visually hidden so the row reads
 * "Failed: web-fetch …" to assistive tech. `actions` render outside the toggle
 * button, so they stay separate Tab stops and never expand the row.
 */
export function ToolCallRow({
  name,
  server,
  summary,
  state,
  durationMs,
  at,
  actions,
  defaultOpen = false,
  onToggle,
  children,
}: ToolCallRowProps): JSX.Element {
  const expandable = children != null;
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const atTime = at != null ? formatTime(at) : '';

  const toggle = () => {
    const next = !open;
    setOpen(next);
    onToggle?.(next);
  };

  return (
    <div className={`tool-call tool-call-${state}`} data-state={state}>
      <div className="tool-call-head">
        <ToolCallToggle
          state={state}
          name={name}
          server={server}
          summary={summary}
          durationMs={durationMs}
          at={at}
          atTime={atTime}
          expandable={expandable}
          open={open}
          bodyId={bodyId}
          onToggle={toggle}
        />
        {actions != null && <div className="tool-call-actions">{actions}</div>}
      </div>
      {expandable && open && (
        <div className="tool-call-body" id={bodyId}>
          {children}
        </div>
      )}
    </div>
  );
}
