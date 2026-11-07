import { useEffect, useRef, type RefObject } from 'react';

/**
 * Queues a selector to focus inside `ref` after the next render. List fields
 * use it when an edit (move/remove) re-renders the row focus was on: they
 * queue the moved item's button or the next item's toggle, and the effect
 * applies it once the new DOM is in place.
 */
export function usePendingFocus<T extends HTMLElement>(): {
  ref: RefObject<T>;
  focus(selector: string): void;
} {
  const ref = useRef<T>(null);
  const pending = useRef<string | undefined>(undefined);
  useEffect(() => {
    const selector = pending.current;
    pending.current = undefined;
    if (selector != null) ref.current?.querySelector<HTMLElement>(selector)?.focus();
  });
  return {
    ref,
    focus: (selector: string) => {
      pending.current = selector;
    },
  };
}
