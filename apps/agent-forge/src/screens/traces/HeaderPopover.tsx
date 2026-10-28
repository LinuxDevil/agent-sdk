/**
 * A trace-header action that opens a small non-modal dialog under its button
 * ("Add to dataset", "Add to queue"). Escape inside the dialog, or the
 * `close` handed to `children`, closes it and returns focus to the button.
 */
import '../datasets/datasets.css';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

/** The button labelled `label` and, while open, a `role="dialog"` of the same name holding `children(close)`. */
export function HeaderPopover({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };
  return (
    <div className="add-to-dataset">
      <button
        ref={trigger}
        type="button"
        className="btn btn-ghost"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {label}
      </button>
      {open && (
        <div className="add-to-dataset-dialog" role="dialog" aria-label={label} onKeyDown={onKeyDown}>
          {children(close)}
        </div>
      )}
    </div>
  );
}
