/**
 * Keyboard helpers shared by every ARIA menu in the kit ({@link Menu} and the
 * narrow toolbar's overflow menu): roving focus over the enabled
 * `[role^="menuitem"]` entries plus first-letter typeahead. `aria-disabled`
 * items are announced but never receive focus.
 */

/** The enabled menu items inside `menu`, in DOM order. */
function enabledItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')).filter(
    (el) => el.getAttribute('aria-disabled') !== 'true',
  );
}

/**
 * Roving focus between enabled [role^="menuitem"] in `menu`: ArrowDown/ArrowUp wrap, Home/End jump.
 * Returns true when handled.
 */
export function moveMenuFocus(menu: HTMLElement, key: string): boolean {
  const items = enabledItems(menu);
  if (items.length === 0) return false;
  const current = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  switch (key) {
    case 'ArrowDown':
      next = current < 0 ? 0 : (current + 1) % items.length;
      break;
    case 'ArrowUp':
      next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = items.length - 1;
      break;
    default:
      return false;
  }
  items[next]!.focus();
  return true;
}

/**
 * Focus the first enabled item whose label starts with `char` (case-insensitive), after the current one.
 * Wraps around so repeated presses cycle through matching items.
 */
export function typeaheadMenuFocus(menu: HTMLElement, char: string): void {
  const items = enabledItems(menu);
  if (items.length === 0) return;
  const start = items.indexOf(document.activeElement as HTMLElement) + 1;
  const needle = char.toLowerCase();
  for (let step = 0; step < items.length; step += 1) {
    const item = items[(start + step) % items.length]!;
    const labelEl = item.querySelector('.menu-item-label, .overflow-menu-label');
    const label = (labelEl?.textContent ?? item.textContent ?? '').trim();
    if (label.toLowerCase().startsWith(needle)) {
      item.focus();
      return;
    }
  }
}
