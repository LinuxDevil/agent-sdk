import type { JSX } from 'react';

import { runtimeClient } from '../../runtime/runtimeClient';
import type { VersionListItem } from '../../../shared/wireTypes';
import { PendingActionDialog } from './PendingActionDialog';

/** Props for {@link RestoreDialog}: the confirm + request half of L03's restore flow. */
export interface RestoreDialogProps {
  agentId: string;
  /** The timeline version being restored (`v3` in the copy). */
  version: number;
  /** The version the restore will write (`items[0].version + 1`). */
  nextVersion: number;
  /** The open document has unsaved edits; adds the replaces-them warning. */
  dirty: boolean;
  open: boolean;
  onClose(): void;
  /** Called with the new `kind: 'restore'` item after a 201; the parent toasts, reloads and refreshes. */
  onRestored(item: VersionListItem): void;
}

/**
 * The restore confirmation (L03): copy names the source version, the
 * version about to be written and how much history stays put; the
 * on/off switch and published version are called out as untouched. The
 * shared {@link PendingActionDialog} owns the pending/error/close
 * mechanics; this wrapper only runs `POST .../versions/:n/restore`.
 */
export function RestoreDialog({
  agentId,
  version,
  nextVersion,
  dirty,
  open,
  onClose,
  onRestored,
}: RestoreDialogProps): JSX.Element | null {
  return (
    <PendingActionDialog
      open={open}
      onClose={onClose}
      title={`Restore v${version}?`}
      confirmLabel={`Restore v${version}`}
      onConfirm={async () => {
        onRestored(await runtimeClient.restoreVersion(agentId, version));
      }}
    >
      <p>
        This writes v{nextVersion} with the configuration from v{version}. Everything up to v{nextVersion - 1}{' '}
        stays in the history.
      </p>
      <p className="dialog-hint">The agent's on/off switch and published version do not change.</p>
      {dirty ? <p className="dialog-warning" role="alert">You have unsaved edits. Restoring replaces them.</p> : null}
    </PendingActionDialog>
  );
}
