import { isEditableTarget } from '../canvas/isEditableTarget';

/** The shortcuts bound globally by the shell: open the command palette, toggle the Agent Author, open the shortcut sheet. */
export type ShortcutId = 'palette' | 'author' | 'help';

/** One row of the `?` shortcut sheet. */
export interface Shortcut {
  id: string;
  /** How the keys read to a person, e.g. `Ctrl/Cmd+K`. */
  keys: string;
  description: string;
}

/**
 * Every shortcut the `?` sheet lists. `palette`, `author` and `help` are
 * bound globally (see {@link matchShortcut}); the table rows are handled
 * locally by DataTable, and Esc by whichever dialog or screen is open.
 */
export const SHORTCUTS: Shortcut[] = [
  { id: 'palette', keys: 'Ctrl/Cmd+K', description: 'Open the command palette' },
  { id: 'author', keys: 'Ctrl/Cmd+J', description: 'Open or close the Agent Author' },
  { id: 'help', keys: '?', description: 'Show keyboard shortcuts' },
  { id: 'save-version', keys: 'Ctrl/Cmd+S', description: 'Save a version of the agent' },
  { id: 'undo', keys: 'Ctrl/Cmd+Z', description: 'Undo the last canvas edit' },
  { id: 'redo', keys: 'Ctrl/Cmd+Shift+Z', description: 'Redo the last undone edit' },
  { id: 'row-next', keys: 'j', description: 'Next row in a table' },
  { id: 'row-prev', keys: 'k', description: 'Previous row in a table' },
  { id: 'row-open', keys: 'Enter', description: 'Open the selected row' },
  { id: 'close', keys: 'Esc', description: 'Close the palette or this sheet' },
];

/**
 * Which global shortcut a keydown is, if any. Ctrl/Cmd+K and Ctrl/Cmd+J work
 * everywhere (they have no typing meaning; `code === 'KeyK'/'KeyJ'` covers
 * non-Latin layouts) - J included while typing in an input, textarea, select
 * or contenteditable, since it must toggle the Author dock from the composer
 * itself. Plain keys such as `?` are ignored in editable targets.
 */
export function matchShortcut(e: KeyboardEvent): ShortcutId | null {
  const ctrl = e.ctrlKey || e.metaKey;
  const isK = e.key.toLowerCase() === 'k' || e.code === 'KeyK';
  const isJ = e.key.toLowerCase() === 'j' || e.code === 'KeyJ';
  if (ctrl && !e.altKey && !e.shiftKey && isK) return 'palette';
  if (ctrl && !e.altKey && !e.shiftKey && isJ) return 'author';
  if (e.key === '?' && !ctrl && !e.altKey && !isEditableTarget(e.target)) return 'help';
  return null;
}
