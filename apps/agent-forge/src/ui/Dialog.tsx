import './overlay.css';
import { useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useModal } from './useModal';

/** Props for {@link Dialog}: a centred modal for prompts and embedded flows. */
export interface DialogProps {
  open: boolean;
  onClose(): void;
  /** The h2; labels the dialog via aria-labelledby. */
  title: ReactNode;
  /** Muted line under the title; describes the dialog via aria-describedby. */
  description?: ReactNode;
  /** Right-aligned action row at the bottom (stacks vertically below 860 px). */
  footer?: ReactNode;
  /** sm 400 px, md 512 px; default 'md'. */
  size?: 'sm' | 'md';
  /** 'alertdialog' for confirmations that need the stronger semantics; default 'dialog'. */
  role?: 'dialog' | 'alertdialog';
  /** Element to focus on open instead of the first focusable in the dialog. */
  initialFocus?: RefObject<HTMLElement | null>;
  children?: ReactNode;
}

/**
 * The open half of {@link Dialog}: mounts only while `open`, which is what
 * drives useModal's mount/unmount focus move and restore.
 */
function DialogPanel({ onClose, title, description, footer, size = 'md', role = 'dialog', initialFocus, children }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const { onKeyDown } = useModal(panel, { onClose, initialFocus });
  const titleId = useId();
  const descriptionId = useId();
  return createPortal(
    <div className="overlay-scrim overlay-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        className={`dialog dialog-${size}`}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="dialog-header">
          <div>
            <h2 className="dialog-title" id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className="dialog-description" id={descriptionId}>
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm sheet-close"
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>
        {children ? <div className="dialog-body">{children}</div> : null}
        {footer ? <footer className="dialog-footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Centred modal dialog, portalled to `document.body` so `.screen-main`'s size
 * container cannot trap its fixed positioning. Focus moves in on open, is
 * trapped while open, and returns to the opener on close; Escape and a scrim
 * mousedown call `onClose`. Null while `!open`.
 */
export function Dialog(props: DialogProps): JSX.Element | null {
  if (!props.open) return null;
  return <DialogPanel {...props} />;
}

/**
 * Props for {@link ConfirmDialog}: a small `alertdialog` for consequential
 * actions (delete, eject, restore). `description` leads with the consequence.
 */
export interface ConfirmDialogProps {
  open: boolean;
  /** Names the object at stake, e.g. 'Delete “support-bot”?'. */
  title: string;
  /** Consequence first: 'This removes … This can’t be undone.'. */
  description: ReactNode;
  /** The verb on the confirm button, e.g. 'Delete agent'. */
  confirmLabel: string;
  /** Shown instead of `confirmLabel` while `pending`, e.g. 'Deleting…'. */
  pendingLabel?: string;
  /** 'danger' (default) styles the confirm `btn-danger` and focuses Cancel; 'primary' styles `btn-primary` and focuses it. */
  tone?: 'danger' | 'primary';
  /** While true, both footer buttons are disabled and Escape/scrim do nothing. */
  pending?: boolean;
  /** Failure from the last attempt, shown above the footer in danger text. */
  error?: string;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * The standard destructive (or emphasised) confirm: a small `alertdialog` with
 * Cancel + confirm actions. Danger tone puts initial focus on Cancel so the
 * safe choice is the default; primary tone focuses the confirm. Null while `!open`.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  pendingLabel,
  tone = 'danger',
  pending = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element | null {
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  // Pending swallows the close paths (Escape, scrim, the X): an in-flight delete must not look cancelled.
  const onClose = () => {
    if (!pending) onCancel();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      role="alertdialog"
      initialFocus={tone === 'danger' ? cancel : confirm}
      footer={
        <>
          <button ref={cancel} type="button" className="btn" disabled={pending} onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirm}
            type="button"
            className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
            disabled={pending}
            onClick={onConfirm}
          >
            {pending && pendingLabel ? pendingLabel : confirmLabel}
          </button>
        </>
      }
    >
      {error ? (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
