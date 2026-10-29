import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, MoreHorizontal, type LucideIcon } from 'lucide-react';

/** One entry of the narrow builder toolbar's "More" menu; `checked` makes it a menuitemcheckbox. */
export interface ToolbarMenuItem {
  label: string;
  onSelect: () => void;
  checked?: boolean;
  Icon?: LucideIcon;
}

/** Arrow-key roving focus between the menu's items, wrapping at either end. */
function focusSibling(menu: HTMLElement, key: 'ArrowDown' | 'ArrowUp') {
  const entries = Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
  const i = entries.indexOf(document.activeElement as HTMLElement);
  const next = key === 'ArrowDown' ? (i + 1) % entries.length : (i - 1 + entries.length) % entries.length;
  entries[next]?.focus();
}

/** Open state, outside-click dismissal and first-item focus for the menu. */
function useMenuOpen(wrapRef: React.RefObject<HTMLDivElement | null>) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    wrapRef.current?.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, wrapRef]);
  return [open, setOpen] as const;
}

function MenuEntry({ item, onClose }: { item: ToolbarMenuItem; onClose: () => void }) {
  const { Icon } = item;
  return (
    <button
      type="button"
      role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={item.checked}
      className="overflow-menu-item"
      onClick={() => {
        onClose();
        item.onSelect();
      }}
    >
      <span className="overflow-menu-icon" aria-hidden="true">
        {Icon && <Icon size={16} strokeWidth={1.75} />}
      </span>
      <span className="overflow-menu-label">{item.label}</span>
      {item.checked && <Check className="overflow-menu-check" size={14} strokeWidth={1.75} aria-hidden="true" />}
    </button>
  );
}

/**
 * The narrow builder toolbar's "More actions" menu - Debug, Import, Export
 * (and the model badge, Observe and Open trace), which no longer fit next to
 * Run and Save at 375px. A WAI-ARIA menu button: arrow keys move between
 * items, Escape closes it and returns focus to the button.
 */
export function ToolbarMoreMenu({ items, children }: { items: ToolbarMenuItem[]; children?: ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useMenuOpen(wrapRef);

  function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    focusSibling(e.currentTarget, e.key);
  }

  return (
    <div className="overflow-menu" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`btn btn-ghost btn-icon panel-toggle${open ? ' active' : ''}`}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        onClick={() => setOpen((o) => !o)}
      >
        <MoreHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <div className="overflow-menu-list" role="menu" aria-label="More actions" onKeyDown={onMenuKeyDown}>
          {children}
          {items.map((item) => (
            <MenuEntry key={item.label} item={item} onClose={() => setOpen(false)} />
          ))}
        </div>
      )}
    </div>
  );
}
