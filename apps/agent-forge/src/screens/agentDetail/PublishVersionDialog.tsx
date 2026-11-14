import { useState, type JSX } from 'react';

import type { EvalGateResult } from '../../../shared/wireTypes';
import { EvalGateDialog } from '../../components/EvalGateDialog';
import { evalGateFailureOf } from '../../components/evalGateFailure';
import { runtimeClient } from '../../runtime/runtimeClient';
import { PendingActionDialog } from './PendingActionDialog';

/** Props for {@link PublishVersionDialog}: the confirm + request half of L14b's "Publish this". */
export interface PublishVersionDialogProps {
  agentId: string;
  /** The timeline version being pinned (`v3` in the copy). */
  version: number;
  open: boolean;
  onClose(): void;
  /** Called with the pinned version after a successful publish; the parent toasts and refreshes. */
  onPublished(version: number): void;
}

/**
 * The "Publish this" confirmation (L14b): copy names the version about to
 * go live and reassures that the working copy does not change. The shared
 * {@link PendingActionDialog} owns the pending/error/close mechanics;
 * this wrapper only runs `POST .../publish { version }`. A 409 eval-gate
 * failure (X01b) swaps this dialog for {@link EvalGateDialog} carrying the
 * full result; any other failure stays in the confirm dialog's error line.
 */
export function PublishVersionDialog({
  agentId,
  version,
  open,
  onClose,
  onPublished,
}: PublishVersionDialogProps): JSX.Element | null {
  const [gateFailure, setGateFailure] = useState<{ version: number; result: EvalGateResult } | null>(null);
  return (
    <>
      <PendingActionDialog
        open={open}
        onClose={onClose}
        title={`Publish v${version}?`}
        description={`v${version} becomes the live version. Serve, deploy and triggers use it. Your working copy does not change.`}
        confirmLabel={`Publish v${version}`}
        onConfirm={async () => {
          try {
            const { publishedVersion } = await runtimeClient.publish(agentId, { version });
            onPublished(publishedVersion);
          } catch (error) {
            const failure = evalGateFailureOf(error);
            if (failure === null) throw error;
            setGateFailure(failure);
            onClose();
          }
        }}
      />
      {gateFailure !== null && (
        <EvalGateDialog
          open
          onClose={() => setGateFailure(null)}
          version={gateFailure.version}
          result={gateFailure.result}
        />
      )}
    </>
  );
}
