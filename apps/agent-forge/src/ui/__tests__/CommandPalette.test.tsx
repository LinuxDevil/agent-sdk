import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from './render';

const appState = vi.hoisted(() => ({
  agents: [
    { id: 'support-bot', spec: { name: 'Support Bot' } },
    { id: 'researcher', spec: { name: '' } },
  ],
  switchAgent: vi.fn<[string], Promise<void>>(() => Promise.resolve()),
}));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

import { CommandPalette, buildCommands } from '../CommandPalette';
import { SHORTCUTS, matchShortcut } from '../../shell/shortcuts';
import { applyStoredTheme } from '../../shell/theme';
import { ToastProvider } from '../Toast';

const mount = () =>
  render(
    <ToastProvider>
      <CommandPalette />
    </ToastProvider>,
  );

const key = (k: string, init: KeyboardEventInit = {}, target: EventTarget = window) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });

const dialog = (name: string) => document.querySelector(`[role="dialog"][aria-label="${name}"]`) as HTMLElement | null;
const input = () => document.querySelector('[role="combobox"]') as HTMLInputElement;
const options = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);

function type(value: string) {
  const el = input();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function stubScheme(dark: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: dark,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  window.location.hash = '#/traces';
  appState.switchAgent.mockReset();
  appState.switchAgent.mockImplementation(() => Promise.resolve());
  document.documentElement.removeAttribute('data-theme');
  // jsdom's localStorage is unavailable under this Node (see DataTable.test.tsx)
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
});

describe('CommandPalette', () => {
  it('Ctrl+K opens it, typing filters, Enter navigates and closes', () => {
    mount();
    expect(dialog('Command palette')).toBeNull();
    key('k', { ctrlKey: true });
    expect(dialog('Command palette')?.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(input());
    expect(options()).toContain('Go to Monitoring');
    expect(options()).toContain('Open agent Support Bot');
    expect(options()).toContain('Toggle theme');

    type('moni');
    expect(options()).toEqual(['Go to Monitoring']);
    key('Enter', {}, input());
    expect(window.location.hash).toBe('#/monitoring');
    expect(dialog('Command palette')).toBeNull();
  });

  it('Cmd+K opens it even from inside an input, and focus returns there on close', () => {
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    mount();
    key('k', { metaKey: true }, field);
    expect(dialog('Command palette')).not.toBeNull();
    key('Escape', {}, input());
    expect(dialog('Command palette')).toBeNull();
    expect(document.activeElement).toBe(field);
    field.remove();
  });

  it('arrow keys move the active option and aria-activedescendant follows', () => {
    mount();
    key('k', { ctrlKey: true });
    type('open agent');
    // the label is the spec name, falling back to the id when the name is empty
    expect(options()).toEqual(['Open agent Support Bot', 'Open agent researcher']);
    const activeText = () => document.getElementById(input().getAttribute('aria-activedescendant')!)?.textContent;
    expect(activeText()).toBe('Open agent Support Bot');
    key('ArrowDown', {}, input());
    expect(activeText()).toBe('Open agent researcher');
    key('ArrowDown', {}, input());
    expect(activeText()).toBe('Open agent Support Bot');
    key('ArrowUp', {}, input());
    key('Enter', {}, input());
    expect(window.location.hash).toBe('#/agents/researcher');
    // Only the hash: the Agents screen's route sync opens it (and asks about unsaved changes).
    expect(appState.switchAgent).not.toHaveBeenCalled();
  });

  it('pasting a trace id offers "Open trace <id>" first', () => {
    mount();
    key('k', { ctrlKey: true });
    type('4bf92f3577b34da6');
    expect(options()[0]).toBe('Open trace 4bf92f3577b34da6');
    key('Enter', {}, input());
    expect(window.location.hash).toBe('#/traces/4bf92f3577b34da6');
  });

  it('shows an empty message when nothing matches, and the backdrop closes it', () => {
    mount();
    key('k', { ctrlKey: true });
    type('zzzz');
    expect(options()).toEqual([]);
    expect(document.querySelector('.cmdk-empty')?.textContent).toBe('No matching commands');
    expect(input().getAttribute('aria-expanded')).toBe('false');
    const backdrop = document.querySelector('.cmdk-backdrop')!;
    act(() => {
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(dialog('Command palette')).toBeNull();
  });

  it('? opens the shortcut sheet listing SHORTCUTS; Esc closes it', () => {
    mount();
    key('?');
    const sheet = dialog('Keyboard shortcuts');
    expect(sheet).not.toBeNull();
    expect([...sheet!.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(SHORTCUTS.map((s) => s.keys));
    key('Escape', {}, document.activeElement!);
    expect(dialog('Keyboard shortcuts')).toBeNull();
  });

  it('ignores ? typed inside an editable target', () => {
    const area = document.createElement('textarea');
    document.body.appendChild(area);
    mount();
    key('?', {}, area);
    expect(dialog('Keyboard shortcuts')).toBeNull();
    area.remove();
  });

  it('Toggle theme flips the effective scheme and remembers it', () => {
    stubScheme(true);
    mount();
    key('k', { ctrlKey: true });
    type('theme');
    key('Enter', {}, input());
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(window.localStorage.getItem('forge.theme')).toBe('light');

    document.documentElement.removeAttribute('data-theme');
    applyStoredTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('CommandPalette edge cases', () => {
  // A failed open is reported by the Agents route sync (screens/agents/__tests__/agentRoute.test.tsx).
  it('opening an agent never switches it directly', () => {
    mount();
    key('k', { ctrlKey: true });
    type('support bot');
    key('Enter', {}, input());
    expect(window.location.hash).toBe('#/agents/support-bot');
    expect(appState.switchAgent).not.toHaveBeenCalled();
  });

  it('ignores Enter while an IME composition is in progress', () => {
    mount();
    key('k', { ctrlKey: true });
    type('moni');
    key('Enter', { isComposing: true }, input());
    expect(dialog('Command palette')).not.toBeNull();
    expect(window.location.hash).toBe('#/traces');
  });

  it('ignores auto-repeat so holding Ctrl+K does not flicker', () => {
    mount();
    key('k', { ctrlKey: true });
    key('k', { ctrlKey: true, repeat: true }, input());
    expect(dialog('Command palette')).not.toBeNull();
    key('k', { ctrlKey: true }, input());
    expect(dialog('Command palette')).toBeNull();
  });

  it('does not try to refocus an opener that has left the DOM', () => {
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    const focus = vi.spyOn(field, 'focus');
    mount();
    key('k', { ctrlKey: true }, field);
    field.remove();
    expect(() => key('Escape', {}, input())).not.toThrow();
    expect(dialog('Command palette')).toBeNull();
    expect(focus).not.toHaveBeenCalled();
  });
});

describe('CommandPalette modal keys', () => {
  it.each([
    ['palette', () => key('k', { ctrlKey: true }), () => input()],
    ['? sheet', () => key('?'), () => document.querySelector('button.btn') as HTMLElement],
  ])('the %s keeps keydown away from window-level handlers behind it', (_name, open, focused) => {
    const behind = vi.fn();
    mount();
    open();
    window.addEventListener('keydown', behind);
    try {
      const target = focused();
      for (const k of ['s', 'j', 'ArrowDown', 'Enter']) key(k, {}, target);
      expect(behind).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', behind);
    }
  });

  it('still toggles with Ctrl+K from inside the palette and lets keys through once closed', () => {
    const behind = vi.fn();
    mount();
    key('k', { ctrlKey: true });
    key('k', { ctrlKey: true }, input());
    expect(dialog('Command palette')).toBeNull();
    window.addEventListener('keydown', behind);
    try {
      key('s', {}, document.body);
      expect(behind).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', behind);
    }
  });
});

describe('CommandPalette groups and look', () => {
  const groups = () =>
    [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="group"]')].map((g) => ({
      name: document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent,
      options: [...g.querySelectorAll('[role="option"]')].map((o) => o.textContent),
    }));

  it('groups commands under section labels, in the order the keyboard walks them', () => {
    mount();
    key('k', { ctrlKey: true });
    const all = options();
    expect(groups().map((g) => g.name)).toEqual(['Navigation', 'Agents', 'Actions']);
    expect(groups().flatMap((g) => g.options)).toEqual(all);
    expect(groups()[1]!.options).toEqual(['Open agent Support Bot', 'Open agent researcher']);
    expect(groups()[2]!.options).toEqual(['Toggle theme']);
    // Every option carries a decorative icon; the label is its whole text.
    for (const o of document.querySelectorAll('[role="option"]')) {
      expect(o.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    }
    // ArrowUp from the first option wraps to the last group's last option.
    key('ArrowUp', {}, input());
    const active = document.getElementById(input().getAttribute('aria-activedescendant')!);
    expect(active?.textContent).toBe('Toggle theme');
    expect(active?.closest('[role="group"]')).toBe(document.querySelectorAll('[role="group"]')[2]);
  });

  it('puts a pasted trace id in its own leading group', () => {
    mount();
    key('k', { ctrlKey: true });
    type('4bf92f3577b34da6');
    expect(groups()).toEqual([{ name: 'Trace', options: ['Open trace 4bf92f3577b34da6'] }]);
  });

  it('shows a search icon, an Esc hint and a footer of key hints', () => {
    mount();
    key('k', { ctrlKey: true });
    const palette = dialog('Command palette')!;
    expect(palette.querySelector('.cmdk-search svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(palette.querySelector('.cmdk-search kbd')?.textContent).toBe('Esc');
    const footer = palette.querySelector('.cmdk-footer')!;
    expect(footer.textContent).toMatch(/navigate/);
    expect(footer.textContent).toMatch(/open/);
    expect(footer.textContent).toMatch(/close/);
    expect(footer.querySelectorAll('kbd').length).toBeGreaterThanOrEqual(3);
    // Still the one focusable control: Tab stays on the input.
    expect(palette.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])')).toHaveLength(0);
  });
});

describe('buildCommands groups', () => {
  it('labels navigation, agent, action and trace commands with their group', () => {
    const groupsOf = (q: string) => buildCommands(q, [{ id: 'a', name: 'Alpha' }], () => {}).map((c) => c.group);
    expect(new Set(groupsOf(''))).toEqual(new Set(['Navigation', 'Agents', 'Actions']));
    expect(groupsOf('abcdef12')[0]).toBe('Trace');
  });
});

describe('matchShortcut', () => {
  const ev = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: k, ...init });
  it('maps Ctrl/Cmd+K and ? and nothing else', () => {
    expect(matchShortcut(ev('k', { ctrlKey: true }))).toBe('palette');
    expect(matchShortcut(ev('K', { metaKey: true }))).toBe('palette');
    expect(matchShortcut(ev('л', { ctrlKey: true, code: 'KeyK' }))).toBe('palette'); // Russian layout
    expect(matchShortcut(ev('?'))).toBe('help');
    expect(matchShortcut(ev('k'))).toBeNull();
    expect(matchShortcut(ev('j'))).toBeNull();
    expect(matchShortcut(ev('Escape'))).toBeNull();
  });
});

describe('buildCommands', () => {
  const noop = () => {};
  it('only treats 8+ hex/dash characters as a trace id', () => {
    expect(buildCommands('abc-1234', [], noop)[0].label).toBe('Open trace abc-1234');
    expect(buildCommands('abc123', [], noop)).toEqual([]);
    expect(buildCommands('go to traces!', [], noop)).toEqual([]);
    expect(buildCommands('GO TO TRACES', [], noop).map((c) => c.label)).toEqual(['Go to Traces']);
  });
});
