import { describe, expect, it } from 'vitest';
import { SHORTCUTS, matchShortcut } from '../shortcuts';

const ev = (key: string, init: KeyboardEventInit = {}) =>
  new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });

describe('matchShortcut — Ctrl/Cmd+J (Agent Author, AA19)', () => {
  it('maps Ctrl+J and Cmd+J to author', () => {
    expect(matchShortcut(ev('j', { ctrlKey: true }))).toBe('author');
    expect(matchShortcut(ev('J', { metaKey: true }))).toBe('author');
    expect(matchShortcut(ev('J', { ctrlKey: true, code: 'KeyJ' }))).toBe('author');
  });

  it('covers non-Latin layouts through code === KeyJ', () => {
    expect(matchShortcut(ev('о', { ctrlKey: true, code: 'KeyJ' }))).toBe('author'); // Russian layout
  });

  it('works while typing in an editable target (the composer itself)', () => {
    const area = document.createElement('textarea');
    document.body.appendChild(area);
    try {
      const e = new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true, cancelable: true });
      area.dispatchEvent(e);
      expect(matchShortcut(e)).toBe('author');
    } finally {
      area.remove();
    }
  });

  it('ignores Shift/Ctrl+Shift+J, Alt combos and plain j', () => {
    expect(matchShortcut(ev('j', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(matchShortcut(ev('j', { metaKey: true, shiftKey: true }))).toBeNull();
    expect(matchShortcut(ev('j', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(matchShortcut(ev('j'))).toBeNull();
    expect(matchShortcut(ev('j', { shiftKey: true }))).toBeNull();
  });

  it('does not shadow Ctrl/Cmd+K or ?', () => {
    expect(matchShortcut(ev('k', { ctrlKey: true }))).toBe('palette');
    expect(matchShortcut(ev('?'))).toBe('help');
  });
});

describe('SHORTCUTS', () => {
  it('lists the Agent Author row for the ? sheet', () => {
    expect(SHORTCUTS).toContainEqual({
      id: 'author',
      keys: 'Ctrl/Cmd+J',
      description: 'Open or close the Agent Author',
    });
  });
});
