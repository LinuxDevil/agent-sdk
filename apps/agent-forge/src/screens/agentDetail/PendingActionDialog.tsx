import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';

import { errorMessage } from '../../components/errorMessage';
import { Dialog } from '../../ui/Dialog';

/** Props for {@link PendingActionDialog}: the confirm + in-flight half shared by the version dialogs. */
export interface PendingActionDialogProps {
  open: boolean;
  onClose(): void;
  /** The h2, e.g. 'Publish v3?'. */
  title: string;
  /** aria-describedby line under the title. */
  description?: ReactNode;
  /** The verb on the confirm button, e.g. 'Publish v3'. */
  confirmLabel: string;
  /**
   * Runs on confirm. Resolves → the parent's success callback closes the
   * dialog (both consumers do); rejects → the dialog stays open with the
   * error in `.dialog-error`.
   */
  onConfirm(): Promise<void>;
  children?: ReactNode;
}

/**
 * The shared skeleton of the version dialogs (L03 restore, L14b publish):
 * a small `alertdialog` whose confirm runs an async action. While it runs
 * both buttons disable, the confirm shows a spinner and Escape/scrim are
 * swallowed; a failure keeps the dialog open with the server's message.
 * Pending/error reset each time the dialog opens, so a successful action
 * that closes it cannot leave the next open stuck busy.
 */
export function PendingActionDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  onConfirm,
  children,
}: PendingActionDialogProps): JSX.Element | null {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const cancel = useRef<HTMLButtonElement>(null);

  // A fresh open starts clean - a previous success leaves `pending` set
  // because the close unmounts nothing.
  useEffect(() => {
    if (open) {
      setPending(false);
      setError(undefined);
    }
  }, [open]);

  const confirm = async () => {
    setPending(true);
    setError(undefined);
    try {
      await onConfirm();
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };

  // Pending swallows the close paths: an in-flight action must not look cancelled.
  const close = () => {
    if (!pending) onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      description={description}
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
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
      {error !== undefined ? (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
