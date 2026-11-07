import './menu.css';
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, MoreHorizontal, type LucideIcon } from 'lucide-react';
import { anchorStyle } from './anchor';
import { moveMenuFocus, typeaheadMenuFocus } from './menuKeys';
import { Kbd } from './Kbd';

/** One actionable row of a {@link Menu}: a menuitem, or a menuitemcheckbox when `checked` is set. */
export interface MenuAction {
  id: string;
  label: string;
  onSelect(): void;
  icon?: LucideIcon;
  tone?: 'danger';
  disabled?: boolean;
  /** Required when disabled: shown as title and appended for screen readers. */
  disabledReason?: string;
  /** Renders the row as role="menuitemcheckbox" with a check mark. */
  checked?: boolean;
  /** 'Mod+D' → <Kbd>. */
  shortcut?: string;
}

/** A {@link Menu} row: an action, a separator line, or a group heading. */
export type MenuEntry = MenuAction | { id: string; separator: true } | { id: string; heading: string };

/** Visual and textual shape of a {@link Menu} trigger; no `text` means the icon-only default. */
export interface MenuTriggerOptions {
  text?: string;
  icon?: LucideIcon;
  variant?: 'ghost' | 'secondary' | 'primary';
  size?: 'sm' | 'md';
  caret?: boolean;
}

/** Props for {@link Menu}: a WAI-ARIA menu button opening a portalled action list. */
// fallow-ignore-next-line unused-type -- contract surface: adopted by the overflow menus in A04/A12 and W05a.
export interface MenuProps {
  /** Names the trigger (aria-label/title when icon-only) and the menu itself. */
  label: string;
  items: MenuEntry[];
  trigger?: MenuTriggerOptions;
  /** Which edge of the menu aligns to the trigger; default 'end'. */
  align?: 'start' | 'end';
  disabled?: boolean;
  /** Why the trigger is off; shown as its title. */
  disabledReason?: string;
}

/** One action row of the menu list. */
function MenuItemView({ item, onSelect }: { item: MenuAction; onSelect: (item: MenuAction) => void }) {
  const Icon = item.icon;
  const checkbox = item.checked !== undefined;
  return (
    <button
      type="button"
      role={checkbox ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={checkbox ? item.checked : undefined}
      aria-disabled={item.disabled || undefined}
      title={item.disabled ? item.disabledReason : undefined}
      tabIndex={-1}
      className={`menu-item${item.tone === 'danger' ? ' menu-item-danger' : ''}`}
      onClick={() => onSelect(item)}
    >
      <span className="menu-item-icon" aria-hidden="true">
        {Icon ? <Icon size={16} strokeWidth={1.75} /> : null}
      </span>
      <span className="menu-item-label">
        {item.label}
        {item.disabled && item.disabledReason ? (
          <span className="visually-hidden">{` (${item.disabledReason})`}</span>
        ) : null}
      </span>
      {item.shortcut ? (
        <span className="menu-item-kbd">
          <Kbd combo={item.shortcut} />
        </span>
      ) : null}
      {item.checked ? <Check size={14} strokeWidth={1.75} className="menu-item-check" aria-hidden="true" /> : null}
    </button>
  );
}

/** Renders one {@link MenuEntry}: separator, heading or action. */
function MenuEntryView({ entry, onSelect }: { entry: MenuEntry; onSelect: (item: MenuAction) => void }) {
  if ('separator' in entry) return <div className="menu-separator" role="separator" />;
  if ('heading' in entry) {
    return (
      <div className="menu-heading overline" role="presentation">
        {entry.heading}
      </div>
    );
  }
  return <MenuItemView item={entry} onSelect={onSelect} />;
}

interface MenuTriggerProps {
  label: string;
  menuId: string;
  open: boolean;
  trigger?: MenuTriggerOptions;
  disabled?: boolean;
  disabledReason?: string;
  buttonRef: RefObject<HTMLButtonElement>;
  onToggle(): void;
  onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>): void;
}

/** Button classes for the trigger: icon-only ghost, or `btn btn-<variant>` (+ `btn-sm`) for a labelled one. */
function triggerClasses(trigger?: MenuTriggerOptions): string {
  if (!trigger?.text) return 'btn btn-ghost btn-icon menu-trigger';
  return `btn btn-${trigger.variant ?? 'secondary'} menu-trigger${trigger.size === 'sm' ? ' btn-sm' : ''}`;
}

/** The trigger's tooltip: the reason it is off, else the label that names an icon-only trigger. */
function triggerTitle({ label, trigger, disabled, disabledReason }: Pick<MenuTriggerProps, 'label' | 'trigger' | 'disabled' | 'disabledReason'>): string | undefined {
  if (disabled) return disabledReason;
  return trigger?.text ? undefined : label;
}

/** Trigger contents: the icon-only glyph, or label text with optional leading icon and caret. */
function TriggerContent({ trigger }: { trigger?: MenuTriggerOptions }) {
  const Icon = trigger?.icon ?? MoreHorizontal;
  if (!trigger?.text) return <Icon size={16} strokeWidth={1.75} aria-hidden="true" />;
  return (
    <>
      {trigger.icon ? <Icon size={16} strokeWidth={1.75} aria-hidden="true" /> : null}
      {trigger.text}
      {trigger.caret ? <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" /> : null}
    </>
  );
}

/**
 * The trigger half of {@link Menu}: icon-only ghost `MoreHorizontal` by default
 * (named by aria-label/title), or a labelled `btn btn-<variant>` with optional
 * leading icon and trailing caret when `trigger.text` is set.
 */
function MenuTrigger({ label, menuId, open, trigger, disabled, disabledReason, buttonRef, onToggle, onKeyDown }: MenuTriggerProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={triggerClasses(trigger)}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={menuId}
      aria-label={trigger?.text ? undefined : label}
      title={triggerTitle({ label, trigger, disabled, disabledReason })}
      disabled={disabled}
      onClick={onToggle}
      onKeyDown={onKeyDown}
    >
      <TriggerContent trigger={trigger} />
    </button>
  );
}

interface MenuListProps {
  menuId: string;
  label: string;
  items: MenuEntry[];
  pos: { top: number; left: number };
  listRef: RefObject<HTMLDivElement>;
  onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void;
  onSelect(item: MenuAction): void;
}

/**
 * The portalled list half of {@link Menu}, under document.body so `.screen-main`'s
 * size container cannot trap its fixed positioning and it stacks above sheets (z 80).
 */
function MenuList({ menuId, label, items, pos, listRef, onKeyDown, onSelect }: MenuListProps): JSX.Element {
  return createPortal(
    <div
      ref={listRef}
      id={menuId}
      className="menu-list"
      role="menu"
      aria-label={label}
      style={{ top: pos.top, left: pos.left }}
      onKeyDown={onKeyDown}
    >
      {items.map((entry) => (
        <MenuEntryView key={entry.id} entry={entry} onSelect={onSelect} />
      ))}
    </div>,
    document.body,
  );
}

/**
 * The kit's WAI-ARIA menu button: a trigger plus a menu portalled to
 * document.body (so it works inside sheets and the dock). Arrow keys rove
 * between enabled items, a printable key jumps by first letter, Enter/Space/
 * click select, Escape and Tab close. Disabled items stay visible with their
 * reason as title and a screen-reader suffix.
 */
export function Menu({ label, items, trigger, align = 'end', disabled, disabledReason }: MenuProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  /** Which end of the list receives focus when the menu next opens. */
  const pendingEdge = useRef<'first' | 'last'>('first');

  const openMenu = (edge: 'first' | 'last') => {
    pendingEdge.current = edge;
    setOpen(true);
  };

  // Position (flipping near the viewport edge) and move focus in, after the list mounts.
  useLayoutEffect(() => {
    const list = listRef.current;
    const btn = triggerRef.current;
    if (!open || !list || !btn) return;
    const size = list.getBoundingClientRect();
    const p = anchorStyle(
      btn.getBoundingClientRect(),
      { width: size.width, height: size.height },
      { side: 'bottom', align, offset: 4, viewport: { width: window.innerWidth, height: window.innerHeight } },
    );
    setPos({ top: p.top, left: p.left });
    moveMenuFocus(list, pendingEdge.current === 'first' ? 'Home' : 'End');
  }, [open, align]);

  // Close on outside pointerdown, window resize and any scroll (capture) while open.
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !listRef.current?.contains(t)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  // Focus the trigger *before* onSelect so a Sheet/Dialog the item opens
  // remembers the trigger as its element to restore focus to.
  const selectItem = (item: MenuAction) => {
    if (item.disabled) return;
    setOpen(false);
    triggerRef.current?.focus();
    item.onSelect();
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      openMenu('first');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu('last');
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (moveMenuFocus(e.currentTarget, e.key)) {
      e.preventDefault();
      return;
    }
    // jsdom never activates a button on Enter/Space keydown, so run the item's
    // click through selectItem's enabled check ourselves.
    if (e.key === 'Enter' || e.key === ' ') {
      const target = e.target as HTMLElement;
      if (target.getAttribute('role')?.startsWith('menuitem')) {
        e.preventDefault();
        target.click();
      }
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      typeaheadMenuFocus(e.currentTarget, e.key);
    }
  };

  return (
    <div className="menu" ref={wrapRef}>
      <MenuTrigger
        label={label}
        menuId={menuId}
        open={open}
        trigger={trigger}
        disabled={disabled}
        disabledReason={disabledReason}
        buttonRef={triggerRef}
        onToggle={() => (open ? setOpen(false) : openMenu('first'))}
        onKeyDown={onTriggerKeyDown}
      />
      {open ? (
        <MenuList
          menuId={menuId}
          label={label}
          items={items}
          pos={pos}
          listRef={listRef}
          onKeyDown={onMenuKeyDown}
          onSelect={selectItem}
        />
      ) : null}
    </div>
  );
}
