import './tooltip.css';
import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { anchorStyle } from './anchor';

/** Props for {@link Tooltip}: a delayed, non-focusable hint attached to a single child. */
// fallow-ignore-next-line unused-type -- contract surface: tooltips land across the screens in A/W-tier tickets.
export interface TooltipProps {
  /** What the bubble says; keep it to a short reason or name. */
  content: ReactNode;
  /** The element the tooltip describes; must be focusable (wrap a disabled control in `<span tabIndex={0}>`). */
  children: ReactElement;
  /** Which side of the child to prefer; flips when there is no room. Default 'top'. */
  side?: 'top' | 'bottom';
  /** Hover/focus delay before the tooltip appears. Default 300. */
  delayMs?: number;
}

/**
 * Neutral tooltip: appears `delayMs` after the child is hovered or focused and
 * closes on leave, blur or Escape. Portalled to document.body, pointer-events
 * none so it never steals hover or focus, and linked back with
 * `aria-describedby` only while visible.
 */
export function Tooltip({ content, children, side = 'top', delayMs = 300 }: TooltipProps): JSX.Element {
  const tipId = useId();
  const tipRef = useRef<HTMLDivElement>(null);
  const anchorEl = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [placed, setPlaced] = useState(side);

  const clearTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const show = (el: HTMLElement) => {
    anchorEl.current = el;
    clearTimer();
    timer.current = setTimeout(() => setOpen(true), delayMs);
  };
  const hide = () => {
    clearTimer();
    setOpen(false);
  };

  // Never leave a pending open behind on unmount.
  useEffect(() => clearTimer, []);

  // Escape anywhere dismisses the tooltip while it is up (it never holds focus itself).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Centre over the child on the preferred side, flipping when there is no room.
  useLayoutEffect(() => {
    const el = anchorEl.current;
    const tip = tipRef.current;
    if (!open || !el || !tip) return;
    const size = tip.getBoundingClientRect();
    const p = anchorStyle(el.getBoundingClientRect(), { width: size.width, height: size.height }, {
      side,
      align: 'center',
      offset: 6,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    setPos({ top: p.top, left: p.left });
    setPlaced(p.side);
  }, [open, side]);

  const child = cloneElement(children, {
    'aria-describedby': open ? tipId : undefined,
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      (children.props as { onMouseEnter?: (ev: React.MouseEvent<HTMLElement>) => void }).onMouseEnter?.(e);
      show(e.currentTarget);
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      (children.props as { onMouseLeave?: (ev: React.MouseEvent<HTMLElement>) => void }).onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      (children.props as { onFocus?: (ev: React.FocusEvent<HTMLElement>) => void }).onFocus?.(e);
      show(e.currentTarget);
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      (children.props as { onBlur?: (ev: React.FocusEvent<HTMLElement>) => void }).onBlur?.(e);
      hide();
    },
  });

  return (
    <>
      {child}
      {open
        ? createPortal(
            <div ref={tipRef} id={tipId} role="tooltip" className={`tooltip tooltip-${placed}`} style={{ top: pos.top, left: pos.left }}>
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
