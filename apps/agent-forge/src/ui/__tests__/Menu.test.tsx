import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Copy, Plus } from 'lucide-react';
import { render } from './render';
import { Menu, type MenuEntry } from '../Menu';

const key = (k: string, target: Element) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });

const pointerDown = (target: Element) =>
  act(() => {
    target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  });

/** Duplicate (icon), Export, a separator, danger Delete and a disabled-with-reason Publish. */
function fixture() {
  const onSelect = { dup: vi.fn(), exp: vi.fn(), del: vi.fn(), pub: vi.fn() };
  const items: MenuEntry[] = [
    { id: 'dup', label: 'Duplicate', onSelect: onSelect.dup, icon: Copy },
    { id: 'exp', label: 'Export', onSelect: onSelect.exp },
    { id: 'sep', separator: true },
    { id: 'del', label: 'Delete', onSelect: onSelect.del, tone: 'danger' },
    { id: 'pub', label: 'Publish', onSelect: onSelect.pub, disabled: true, disabledReason: 'Save a version first' },
  ];
  return { items, onSelect };
}

const trigger = () => document.body.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
const menu = () => document.body.querySelector<HTMLElement>('.menu-list');
const itemBy = (label: string) =>
  [...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((el) =>
    el.textContent?.includes(label),
  );

describe('Menu', () => {
  it('renders an icon-only ghost trigger named by label', () => {
    render(<Menu label="More actions" items={fixture().items} />);
    const btn = trigger()!;
    expect(btn).not.toBeNull();
    expect(btn.className).toContain('btn btn-ghost btn-icon');
    expect(btn.getAttribute('aria-label')).toBe('More actions');
    expect(btn.getAttribute('title')).toBe('More actions');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(menu()).toBeNull();
  });

  it('opens a portalled menu on click, expanded, controlled and focusing the first item', () => {
    render(<Menu label="More actions" items={fixture().items} />);
    act(() => trigger()!.click());
    const el = menu()!;
    expect(el).not.toBeNull();
    expect(el.parentElement).toBe(document.body);
    expect(el.getAttribute('role')).toBe('menu');
    expect(el.getAttribute('aria-label')).toBe('More actions');
    expect(el.getAttribute('style')).toContain('top:');
    expect(el.getAttribute('style')).toContain('left:');
    expect(trigger()!.getAttribute('aria-expanded')).toBe('true');
    expect(trigger()!.getAttribute('aria-controls')).toBe(el.id);
    expect(document.body.querySelectorAll('[role="menuitem"]')).toHaveLength(4);
    expect(document.body.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(document.activeElement).toBe(itemBy('Duplicate'));
    expect(itemBy('Delete')!.className).toContain('menu-item-danger');
    expect(itemBy('Delete')!.tabIndex).toBe(-1);
  });

  it('moves focus with arrows, Home and End, skipping separators and disabled items', () => {
    render(<Menu label="More actions" items={fixture().items} />);
    // ArrowDown on a closed trigger opens and focuses the first enabled item.
    key('ArrowDown', trigger()!);
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(itemBy('Duplicate'));
    key('ArrowDown', menu()!);
    expect(document.activeElement).toBe(itemBy('Export'));
    // The separator has no menuitem role and is skipped.
    key('ArrowDown', menu()!);
    expect(document.activeElement).toBe(itemBy('Delete'));
    // Publish is aria-disabled, so the wrap lands back on Duplicate.
    key('ArrowDown', menu()!);
    expect(document.activeElement).toBe(itemBy('Duplicate'));
    key('End', menu()!);
    expect(document.activeElement).toBe(itemBy('Delete'));
    key('Home', menu()!);
    expect(document.activeElement).toBe(itemBy('Duplicate'));
    // ArrowUp wraps backwards past the disabled Publish too.
    key('ArrowUp', menu()!);
    expect(document.activeElement).toBe(itemBy('Delete'));
  });

  it('typeahead focuses the first enabled item after the current one starting with the char', () => {
    render(<Menu label="More actions" items={fixture().items} />);
    act(() => trigger()!.click());
    key('e', menu()!);
    expect(document.activeElement).toBe(itemBy('Export'));
  });

  it('Enter on an item selects it, closes the menu and focuses the trigger first', () => {
    const { items, onSelect } = fixture();
    render(<Menu label="More actions" items={items} />);
    act(() => trigger()!.click());
    key('Enter', itemBy('Delete')!);
    expect(onSelect.del).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('disabled items announce their reason and never select', () => {
    const { items, onSelect } = fixture();
    render(<Menu label="More actions" items={items} />);
    act(() => trigger()!.click());
    const pub = itemBy('Publish')!;
    expect(pub.getAttribute('aria-disabled')).toBe('true');
    expect(pub.getAttribute('title')).toBe('Save a version first');
    expect(pub.textContent?.endsWith('(Save a version first)')).toBe(true);
    act(() => pub.click());
    expect(onSelect.pub).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it('Escape closes and refocuses the trigger; outside pointerdown closes', () => {
    render(<Menu label="More actions" items={fixture().items} />);
    act(() => trigger()!.click());
    key('Escape', menu()!);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    act(() => trigger()!.click());
    expect(menu()).not.toBeNull();
    pointerDown(document.body);
    expect(menu()).toBeNull();
  });

  it('renders a labelled text trigger with leading icon and caret', () => {
    render(
      <Menu
        label="More actions"
        items={fixture().items}
        trigger={{ text: 'New agent', icon: Plus, variant: 'primary', caret: true }}
      />,
    );
    const btn = trigger()!;
    expect(btn.className).toContain('btn btn-primary');
    expect(btn.textContent).toBe('New agent');
    expect(btn.querySelectorAll('svg')).toHaveLength(2);
    expect(btn.hasAttribute('aria-label')).toBe(false);
  });

  it('checked items render as menuitemcheckbox with a check mark', () => {
    render(<Menu label="More actions" items={[{ id: 'x', label: 'Inline preview', checked: true, onSelect: vi.fn() }]} />);
    act(() => trigger()!.click());
    const item = itemBy('Inline preview')!;
    expect(item.getAttribute('role')).toBe('menuitemcheckbox');
    expect(item.getAttribute('aria-checked')).toBe('true');
    expect(item.querySelector('.menu-item-check')).not.toBeNull();
  });
});
