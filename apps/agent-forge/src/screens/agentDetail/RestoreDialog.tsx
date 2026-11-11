import { useRef, useState, type JSX } from 'react';
import { LoaderCircle } from 'lucide-react';

import { errorMessage } from '../../components/errorMessage';
import { runtimeClient } from '../../runtime/runtimeClient';
import { Dialog } from '../../ui/Dialog';
import type { VersionListItem } from '../../../shared/wireTypes';

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
 * on/off switch and published version are called out as untouched. While
 * `POST .../versions/:n/restore` runs both buttons disable and Restore
 * shows a spinner; a 409/400/404 keeps the dialog open with the server's
 * error in `.dialog-error`. Escape/scrim are swallowed while pending.
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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const cancel = useRef<HTMLButtonElement>(null);

  const confirm = async () => {
    setPending(true);
    setError(undefined);
    try {
      onRestored(await runtimeClient.restoreVersion(agentId, version));
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };

  // Pending swallows the close paths: an in-flight restore must not look cancelled.
  const close = () => {
    if (!pending) onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`Restore v${version}?`}
      size="sm"
      role="alertdialog"
      initialFocus={cancel}
      footer={
        <>
          <button ref={cancel} type="button" className="btn btn-secondary" disabled={pending} onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={() => void confirm()}
          >
            {pending ? <LoaderCircle size={14} className="btn-spinner" aria-hidden="true" /> : null}
            Restore v{version}
          </button>
        </>
      }
    >
      <p>
        This writes v{nextVersion} with the configuration from v{version}. Everything up to v{nextVersion - 1}{' '}
        stays in the history.
      </p>
      <p className="dialog-hint">The agent's on/off switch and published version do not change.</p>
      {dirty ? <p className="dialog-warning" role="alert">You have unsaved edits. Restoring replaces them.</p> : null}
      {error !== undefined ? (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
