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
import { RuntimeApiError } from '../runtime/runtimeClient';

export interface ApprovalCardProps {
  toolName: string;
  args: Record<string, unknown>;
  className?: string;
}

export function ApprovalCard({ toolName, args, className }: ApprovalCardProps) {
  const { approveAgent } = useAppState();
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<'approve' | 'reject' | undefined>(undefined);

  async function handleDecision(approved: boolean) {
    setError(undefined);
    setPending(approved ? 'approve' : 'reject');
    try {
      await approveAgent(approved);
    } catch (err) {
      setError(err instanceof RuntimeApiError ? err.message : (err as Error).message);
    } finally {
      setPending(undefined);
    }
  }

  return (
    <div className={`approval-card${className ? ` ${className}` : ''}`} title={JSON.stringify(args)}>
      <span>
        Approve <b>{toolName}</b>?
      </span>
      <button className="btn btn-success" onClick={() => void handleDecision(true)} disabled={!!pending}>
        {pending === 'approve' ? 'Approving...' : 'Approve'}
      </button>
      <button className="btn btn-danger" onClick={() => void handleDecision(false)} disabled={!!pending}>
        {pending === 'reject' ? 'Rejecting...' : 'Reject'}
      </button>
      {error && <span className="run-error">{error}</span>}
    </div>
  );
}
