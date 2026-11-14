import type { KeyboardEvent } from 'react';

/**
 * j/ArrowDown and k/ArrowUp move focus between the `[data-roving]` buttons
 * inside the list the handler sits on (a timeline, a card list, the node
 * palette), the same keys DataTable rows answer to; Home/End jump to the
 * first/last item and Enter and Space stay the buttons' own.
 */
type RovingTarget = (at: number, count: number) => number;

function stepBy(step: number): RovingTarget {
  return (at, count) => (at === -1 ? 0 : Math.min(count - 1, Math.max(0, at + step)));
}

const ROVING_KEYS: ReadonlyMap<string, RovingTarget> = new Map([
  ['Home', () => 0],
  ['End', (_at: number, count: number) => count - 1],
  ['j', stepBy(1)],
  ['ArrowDown', stepBy(1)],
  ['k', stepBy(-1)],
  ['ArrowUp', stepBy(-1)],
]);

export function onRovingKeyDown(e: KeyboardEvent<HTMLElement>): void {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const target = ROVING_KEYS.get(e.key);
  if (!target) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-roving]')];
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  e.preventDefault();
  items[target(at, items.length)].focus();
}
