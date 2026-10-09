import type { KeyboardEvent } from 'react';

/** DOM ids for a WAI-ARIA tab and its panel, so `aria-controls`/`aria-labelledby` line up. */
export function tabIds(group: string, id: string): { tab: string; panel: string } {
  return { tab: `${group}-tab-${id}`, panel: `${group}-panel-${id}` };
}

/** Which tab an arrow/Home/End key moves to, or undefined for any other key. */
export function nextTabId<T extends string>(ids: readonly T[], current: T, key: string): T | undefined {
  const i = ids.indexOf(current);
  if (key === 'ArrowRight') return ids[(i + 1) % ids.length];
  if (key === 'ArrowLeft') return ids[(i - 1 + ids.length) % ids.length];
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids[ids.length - 1];
  return undefined;
}

/**
 * Eve DUI-F9: roving-focus keyboard handler for a `role="tablist"` - the
 * arrow keys (and Home/End) select and focus the neighbouring tab, as the
 * WAI-ARIA tabs pattern expects. Only the active tab is in the Tab order.
 */
export function tabListKeyDown<T extends string>(group: string, ids: readonly T[], current: T, select: (id: T) => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    const next = nextTabId(ids, current, e.key);
    if (next === undefined) return;
    e.preventDefault();
    select(next);
    document.getElementById(tabIds(group, next).tab)?.focus();
  };
}
