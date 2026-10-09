/**
 * Eve DUI-F10: true when a keyboard event's target is somewhere the user is
 * typing - an `<input>`, `<textarea>`, `<select>` or any contenteditable
 * element (the hook-code CodeMirror editor is one). Canvas shortcuts such as
 * Ctrl/Cmd+D (duplicate node) must leave those keystrokes alone.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  return el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null;
}
