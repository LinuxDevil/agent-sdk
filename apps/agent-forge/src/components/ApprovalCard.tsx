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
import { useState } from 'react';
import { Check, ShieldAlert, X, type LucideIcon } from 'lucide-react';
import { useAppState } from '../state/AppState';
import { JsonView } from '../ui/JsonView';

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
  onClick: () => void;
}

function DecisionButton({ className, Icon, idleLabel, busyLabel, busy, disabled, onClick }: DecisionButtonProps) {
  return (
    <button type="button" className={className} title={idleLabel} onClick={onClick} disabled={disabled}>
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
      {/* The toolbar's inline card keeps only the icon on a short bar (layout.css); the label stays the name. */}
      <span className="approval-btn-label">{busy ? busyLabel : idleLabel}</span>
    </button>
  );
}

function DecisionButtons({ size }: { size: string }) {
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
        onClick={() => void decide('approve')}
      />
      <DecisionButton
        className={`btn btn-danger${size}`}
        Icon={X}
        idleLabel="Reject"
        busyLabel="Rejecting..."
        busy={pending === 'reject'}
        disabled={!!pending}
        onClick={() => void decide('reject')}
      />
      {error && <span className="run-error">{error}</span>}
    </div>
  );
}

export function ApprovalCard({ toolName, args, className, variant = 'card' }: ApprovalCardProps) {
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
        <DecisionButtons size=" btn-sm" />
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
      <DecisionButtons size="" />
    </div>
  );
}
