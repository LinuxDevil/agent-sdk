import type { KeyboardEvent } from 'react';

/**
 * j/ArrowDown and k/ArrowUp move focus between the `[data-roving]` buttons
 * inside the list the handler sits on (a timeline, a card list), the same keys
 * DataTable rows answer to; Enter and Space stay the buttons' own.
 */
export function onRovingKeyDown(e: KeyboardEvent<HTMLElement>): void {
  const step = e.key === 'j' || e.key === 'ArrowDown' ? 1 : e.key === 'k' || e.key === 'ArrowUp' ? -1 : 0;
  if (step === 0 || e.altKey || e.ctrlKey || e.metaKey) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-roving]')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = items[at === -1 ? 0 : Math.min(items.length - 1, Math.max(0, at + step))];
  if (!next) return;
  e.preventDefault();
  next.focus();
}
