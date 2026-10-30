import { useEffect, type KeyboardEvent, type RefObject } from 'react';

/**
 * Selector for the elements a keyboard user can reach: form controls that are
 * not disabled, links with an href, and anything opted into the tab order.
 * `[tabindex^="-"]` drops the -1 elements that are focusable only by script.
 */
const FOCUSABLE = [
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'a[href]',
  '[tabindex]:not([tabindex^="-"])',
].join(', ');

/** The focusable descendants of `root`, in DOM order (buttons/inputs/selects/textareas not disabled, a[href], [tabindex]≥0). */
// fallow-ignore-next-line unused-export -- kit helper for later tickets (menus/tooltips U10); the sheet/dialog tests exercise it through useModal
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/**
 * Move focus one step through `panel`'s focusables, wrapping at both ends so
 * Tab can never leave a modal. With nothing focusable the panel itself holds
 * focus (it carries `tabIndex={-1}` for exactly this). Kept out of the
 * keydown handler so that handler stays a flat key switch.
 */
function cycleFocus(panel: HTMLElement, backwards: boolean): void {
  const items = focusableIn(panel);
  if (items.length === 0) {
    panel.focus();
    return;
  }
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next =
    current === -1
      ? backwards
        ? items.length - 1
        : 0
      : (current + (backwards ? -1 : 1) + items.length) % items.length;
  items[next]!.focus();
}

/**
 * Modal behaviour for a panel element: on mount remembers document.activeElement and focuses `initialFocus`
 * (else the first focusable in the panel, else the panel); Tab/Shift+Tab cycle inside the panel; Escape calls
 * onClose (preventDefault + stopPropagation, so only the top-most modal closes); on unmount restores focus to
 * the remembered element when it is still connected.
 */
export function useModal(
  panel: RefObject<HTMLElement | null>,
  { onClose, initialFocus }: { onClose: () => void; initialFocus?: RefObject<HTMLElement | null> },
): { onKeyDown: (e: KeyboardEvent<HTMLElement>) => void } {
  useEffect(() => {
    const el = panel.current;
    // Captured at mount so a later focus move inside the panel is not mistaken for the opener.
    const previous = document.activeElement as HTMLElement | null;
    if (el) (initialFocus?.current ?? focusableIn(el)[0] ?? el).focus();
    return () => {
      // The opener may have unmounted while the modal was open: then leave focus where it falls.
      if (previous?.isConnected) previous.focus?.();
    };
    // Mount-only: the opener to remember and the element to focus are fixed for the modal's life.
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      // Swallow it whole: a modal behind this one (a Sheet under a Dialog) must not also close,
      // and window-level handlers (nav drawer, side panels) must not see the key.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Tab' && panel.current) {
      e.preventDefault();
      e.stopPropagation();
      cycleFocus(panel.current, e.shiftKey);
    }
  };
  return { onKeyDown };
}
