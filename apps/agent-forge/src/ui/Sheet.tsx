import './overlay.css';
import { useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useModal } from './useModal';

/** Fixed widths for the right-side sheet: sm 384, md 448, lg 512, xl 672, xxl 960 px (≤ 100vw). */
export type SheetSize = 'sm' | 'md' | 'lg' | 'xl' | 'xxl';

/** Props for {@link Sheet}: a right-side modal drawer for detail and form work (diffs, import, export, spans). */
export interface SheetProps {
  open: boolean;
  onClose(): void;
  /** The h2; labels the dialog via aria-labelledby. */
  title: ReactNode;
  /** Muted line under the title; describes the dialog via aria-describedby. */
  description?: ReactNode;
  /** Panel width, default 'md' (448 px). */
  size?: SheetSize;
  /** Right-aligned action row pinned to the bottom. */
  footer?: ReactNode;
  /** Element to focus on open instead of the first focusable in the sheet. */
  initialFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

/**
 * The open half of {@link Sheet}: mounts only while `open`, which is what drives
 * useModal's mount/unmount focus move and restore.
 */
function SheetPanel({ onClose, title, description, size = 'md', footer, initialFocus, children }: SheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const { onKeyDown } = useModal(panel, { onClose, initialFocus });
  const titleId = useId();
  const descriptionId = useId();
  return createPortal(
    <div className="overlay-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        className={`sheet sheet-${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="sheet-header">
          <div className="sheet-heading">
            <h2 className="sheet-title" id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className="sheet-description" id={descriptionId}>
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
        <div className="sheet-body">{children}</div>
        {footer ? <footer className="sheet-footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Right-side modal sheet, portalled to `document.body` (fixed positioning would
 * otherwise resolve against `.screen-main`'s size container). Focus moves in on
 * open, is trapped while open, and returns to the opener on close; Escape and a
 * scrim mousedown call `onClose`. Null while `!open`.
 */
export function Sheet(props: SheetProps): JSX.Element | null {
  if (!props.open) return null;
  return <SheetPanel {...props} />;
}
