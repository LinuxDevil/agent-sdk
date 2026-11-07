/**
 * Fixed-position style for a popup anchored to `rect`, flipping above when it
 * would leave the viewport. Shared by {@link Menu} and {@link Tooltip} so both
 * popups keep the same 8px edge margin and flip rule.
 */
export function anchorStyle(
  rect: DOMRect,
  popup: { width: number; height: number },
  opts: {
    side: 'top' | 'bottom';
    align: 'start' | 'center' | 'end';
    offset: number;
    viewport: { width: number; height: number };
  },
): { top: number; left: number; side: 'top' | 'bottom' } {
  const { side, align, offset, viewport } = opts;
  const { width: w, height: h } = popup;

  let top: number;
  let placed = side;
  if (side === 'bottom') {
    top = rect.bottom + offset;
    if (top + h > viewport.height - 8 && rect.top - offset - h >= 8) {
      top = rect.top - offset - h;
      placed = 'top';
    }
  } else {
    top = rect.top - offset - h;
    if (top < 8) {
      top = rect.bottom + offset;
      placed = 'bottom';
    }
  }

  let left: number;
  if (align === 'start') left = rect.left;
  else if (align === 'end') left = rect.right - w;
  else left = rect.left + rect.width / 2 - w / 2;
  left = Math.min(Math.max(left, 8), Math.max(viewport.width - w - 8, 8));

  return { top, left, side: placed };
}
