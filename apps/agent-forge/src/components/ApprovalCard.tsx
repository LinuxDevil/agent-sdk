/**
 * Shared approve/reject UI for a pending tool-call approval (the
 * human-in-the-loop gate, `POST /agents/:id/approve`). Factored out of
 * Topbar.tsx's original inline `.approval-card` markup so the Chat tab's
 * inline-in-thread approval card (the epic brief's requirement) and the
 * Topbar's compact one render from the exact same component/logic instead
 * of two copies that could drift - only the wrapping/placement differs
 * (Topbar renders it inline in its button row; ChatPanel renders it as a
 * message-thread bubble), which is left to the caller via `className`.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, ShieldAlert, X, type LucideIcon } from 'lucide-react';
import { useAppState } from '../state/AppState';
import { JsonView } from '../ui/JsonView';
import { useDeadline } from './test/useDeadline';

export interface ApprovalCardProps {
  toolName: string;
  args: Record<string, unknown>;
  className?: string;
  /**
   * `card` (default): the Chat thread's warning card - icon, tool name, the
   * call's arguments as a JSON tree, then the decision buttons. `inline`: the
   * toolbar's one-line version, the arguments in its tooltip.
   */
  variant?: 'card' | 'inline';
  /** The pause's self-resolution deadline (PendingApprovalInfo.deadline, ISO) - the "Decide within" line's countdown target. */
  deadline?: string;
}

/**
 * The pause's live deadline line ("Decide within 4m 12s", or "Answer
 * within" on a question card): the visible text ticks every second while
 * the `aria-live` announcement is re-spoken at most every fifteen, so a
 * screen reader isn't drowned by the countdown. Shared by ApprovalCard
 * (verb 'Decide') and test/QuestionCard (verb 'Answer').
 */
export function DeadlineLine({ deadline, verb }: { deadline: string; verb: 'Decide' | 'Answer' }) {
  const { remaining, urgent } = useDeadline(deadline);
  const [spoken, setSpoken] = useState(remaining);
  const lastSpokenAt = useRef(Date.now());
  useEffect(() => {
    const elapsed = Date.now() - lastSpokenAt.current;
    if (elapsed >= 15_000) {
      lastSpokenAt.current = Date.now();
      setSpoken(remaining);
    }
  }, [remaining]);
  return (
    <div className={`deadline-line${urgent ? ' urgent' : ''}`}>
      <span aria-hidden="true">
        {verb} within {remaining}
      </span>
      <span className="visually-hidden" aria-live="polite">
        {verb} within {spoken}
      </span>
    </div>
  );
}

type Decision = 'approve' | 'reject';

function useApprovalDecision() {
  const { approveAgent } = useAppState();
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<Decision | undefined>(undefined);

  async function decide(decision: Decision) {
    setError(undefined);
    setPending(decision);
    try {
      await approveAgent(decision === 'approve');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(undefined);
    }
  }

  return { error, pending, decide };
}

interface DecisionButtonProps {
  className: string;
  Icon: LucideIcon;
  idleLabel: string;
  busyLabel: string;
  busy: boolean;
  disabled: boolean;
  /** The toolbar's inline card: its buttons may go icon-only, so they carry their label as a tooltip. */
  tooltip: boolean;
  onClick: () => void;
}

function DecisionButton({ className, Icon, idleLabel, busyLabel, busy, disabled, tooltip, onClick }: DecisionButtonProps) {
  const label = busy ? busyLabel : idleLabel;
  return (
    <button type="button" className={className} title={tooltip ? label : undefined} onClick={onClick} disabled={disabled}>
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
      {/* The toolbar's inline card keeps only the icon on a short bar (layout.css); the label stays the name. */}
      <span className="approval-btn-label">{label}</span>
    </button>
  );
}

function DecisionButtons({ size, tooltip = false }: { size: string; tooltip?: boolean }) {
  const { error, pending, decide } = useApprovalDecision();
  return (
    <div className="approval-actions">
      <DecisionButton
        className={`btn btn-success${size}`}
        Icon={Check}
        idleLabel="Approve"
        busyLabel="Approving..."
        busy={pending === 'approve'}
        disabled={!!pending}
        tooltip={tooltip}
        onClick={() => void decide('approve')}
      />
      <DecisionButton
        className={`btn btn-danger${size}`}
        Icon={X}
        idleLabel="Reject"
        busyLabel="Rejecting..."
        busy={pending === 'reject'}
        disabled={!!pending}
        tooltip={tooltip}
        onClick={() => void decide('reject')}
      />
      {error && <span className="run-error">{error}</span>}
    </div>
  );
}

export function ApprovalCard({ toolName, args, className, variant = 'card', deadline }: ApprovalCardProps) {
  const classes = `approval-card approval-card-${variant}${className ? ` ${className}` : ''}`;
  if (variant === 'inline') {
    // The tool name is the one fact this prompt must show: it is the only text, and the tooltip repeats it with the args.
    return (
      <div className={classes} title={`Approve ${toolName}? ${JSON.stringify(args)}`}>
        <ShieldAlert className="approval-icon" size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className="approval-text">
          <span className="visually-hidden">Approve </span>
          <b className="approval-tool">{toolName}</b>
          <span className="visually-hidden">?</span>
        </span>
        {deadline !== undefined && <DeadlineLine deadline={deadline} verb="Decide" />}
        <DecisionButtons size=" btn-sm" tooltip />
      </div>
    );
  }
  return (
    <div className={classes}>
      <div className="approval-head">
        <span className="approval-icon-tile" aria-hidden="true">
          <ShieldAlert size={16} strokeWidth={1.75} />
        </span>
        <span className="approval-text">
          <span className="approval-title">Approval required</span>
          <span className="approval-sub">
            Approve <b className="approval-tool">{toolName}</b>?
          </span>
        </span>
      </div>
      <div className="approval-args">
        <JsonView value={args} />
      </div>
      {deadline !== undefined && <DeadlineLine deadline={deadline} verb="Decide" />}
      <DecisionButtons size="" />
    </div>
  );
}
