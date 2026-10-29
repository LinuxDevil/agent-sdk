import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';

/** The save card's open state, and the header trigger it returns focus to. */
export function useSaveDialog() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);
  return { open, toggle, close, triggerRef };
}

interface SaveDialogProps {
  id: string;
  open: boolean;
  onClose: (refocus: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}

/** Closes on a pointer press outside both the card and its trigger. */
function useOutsidePress(open: boolean, card: RefObject<HTMLElement | null>, props: Pick<SaveDialogProps, 'onClose' | 'triggerRef'>) {
  const { onClose, triggerRef } = props;
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (card.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, card, onClose, triggerRef]);
}

/**
 * The "Save as prompt version" popover card under the page header's Save
 * prompt button. It stays mounted while closed (`hidden`), so a typed name
 * survives closing it; opening focuses its first field, Escape or a press
 * outside closes it.
 */
export function SaveDialog({ id, open, onClose, triggerRef, children }: SaveDialogProps) {
  const card = useRef<HTMLDivElement>(null);
  useOutsidePress(open, card, { onClose, triggerRef });
  useEffect(() => {
    if (open) card.current?.querySelector<HTMLElement>('input, button:not(:disabled)')?.focus();
  }, [open]);
  return (
    <div
      ref={card}
      id={id}
      className="card pg-save-dialog"
      role="dialog"
      aria-labelledby={`${id}-title`}
      hidden={!open}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onClose(true);
      }}
    >
      <div className="pg-card-head">
        <div className="pg-save-heading">
          <h2 id={`${id}-title`} className="pg-card-title">
            Save as prompt version
          </h2>
          <p className="pg-card-description">
            Stores the system message and its <code>{'{variables}'}</code> as a new version in the prompt registry.
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Close" onClick={() => onClose(true)}>
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="pg-card-body">{children}</div>
    </div>
  );
}
