/**
 * P2: shared approve/reject UI for a pending tool-call approval (LOU-N's
 * human-in-the-loop gate, `POST /agents/:id/approve`). Factored out of
 * Topbar.tsx's original inline `.approval-card` markup so the Chat tab's
 * inline-in-thread approval card (the epic brief's requirement) and the
 * Topbar's compact one render from the exact same component/logic instead
 * of two copies that could drift - only the wrapping/placement differs
 * (Topbar renders it inline in its button row; ChatPanel renders it as a
 * message-thread bubble), which is left to the caller via `className`.
 */
import { useState } from 'react';
import { useAppState } from '../state/AppState';

export interface ApprovalCardProps {
  toolName: string;
  args: Record<string, unknown>;
  className?: string;
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
  idleLabel: string;
  busyLabel: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}

function DecisionButton({ className, idleLabel, busyLabel, busy, disabled, onClick }: DecisionButtonProps) {
  return (
    <button className={className} onClick={onClick} disabled={disabled}>
      {busy ? busyLabel : idleLabel}
    </button>
  );
}

export function ApprovalCard({ toolName, args, className }: ApprovalCardProps) {
  const { error, pending, decide } = useApprovalDecision();

  return (
    <div className={`approval-card${className ? ` ${className}` : ''}`} title={JSON.stringify(args)}>
      <span>
        Approve <b>{toolName}</b>?
      </span>
      <DecisionButton
        className="btn btn-success"
        idleLabel="Approve"
        busyLabel="Approving..."
        busy={pending === 'approve'}
        disabled={!!pending}
        onClick={() => void decide('approve')}
      />
      <DecisionButton
        className="btn btn-danger"
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
