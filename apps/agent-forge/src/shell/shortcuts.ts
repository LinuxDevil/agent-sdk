import { isEditableTarget } from '../canvas/isEditableTarget';

/** The shortcuts bound globally by the shell: open the command palette, open the shortcut sheet. */
export type ShortcutId = 'palette' | 'help';

/** One row of the `?` shortcut sheet. */
export interface Shortcut {
  id: string;
  /** How the keys read to a person, e.g. `Ctrl/Cmd+K`. */
  keys: string;
  description: string;
}

/**
 * Every shortcut the `?` sheet lists. Only `palette` and `help` are bound
 * globally (see {@link matchShortcut}); the table rows are handled locally by
 * DataTable, and Esc by whichever dialog or screen is open.
 */
export const SHORTCUTS: Shortcut[] = [
  { id: 'palette', keys: 'Ctrl/Cmd+K', description: 'Open the command palette' },
  { id: 'help', keys: '?', description: 'Show keyboard shortcuts' },
  { id: 'row-next', keys: 'j', description: 'Next row in a table' },
  { id: 'row-prev', keys: 'k', description: 'Previous row in a table' },
  { id: 'row-open', keys: 'Enter', description: 'Open the selected row' },
  { id: 'close', keys: 'Esc', description: 'Close the palette or this sheet' },
];

/**
 * Which global shortcut a keydown is, if any. Ctrl/Cmd+K works everywhere
 * (it has no typing meaning; `code === 'KeyK'` covers non-Latin layouts);
 * plain keys such as `?` are ignored while the
 * user is typing in an input, textarea, select or contenteditable.
 */
export function matchShortcut(e: KeyboardEvent): ShortcutId | null {
  const isK = e.key.toLowerCase() === 'k' || e.code === 'KeyK';
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && isK) return 'palette';
  if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditableTarget(e.target)) return 'help';
  return null;
}
