import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({ connected: true, agents: [] }));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

import { AppShell } from '../AppShell';
import { useDock } from '../Dock';
import { DOCK_OPEN_KEY, DOCK_WIDTH_KEY } from '../dockState';
import { ToastProvider } from '../../ui/Toast';
import { render } from '../../ui/__tests__/render';
import { installMemoryStorage } from '../../ui/__tests__/memoryStorage';

// jsdom may not implement pointer capture; the Dock guards the calls, but stub
// them so a jsdom without the API still exercises the drag path.
if (typeof HTMLElement.prototype.setPointerCapture !== 'function') {
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
}

function stubNarrow(narrow: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: narrow,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function setViewport(w: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
}

function mount(dock?: ReactNode) {
  return render(
    <ToastProvider>
      <AppShell dock={dock}>
        <p id="screen">screen</p>
      </AppShell>
    </ToastProvider>,
  );
}

const shellEl = (c: HTMLElement) => c.querySelector('.app-shell') as HTMLElement;
const aside = (c: HTMLElement) => c.querySelector('aside#app-dock') as HTMLElement | null;
const separator = (c: HTMLElement) => c.querySelector('[role="separator"]') as HTMLElement;

const key = (el: Element, k: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });

const pointer = (el: Element, type: string, clientX: number) =>
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true, cancelable: true }));
  });

beforeEach(() => {
  installMemoryStorage();
  stubNarrow(false);
  setViewport(1600);
  window.location.hash = '#/traces';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Dock docked', () => {
  it('opens as a third grid column with the stored open state and default width', () => {
    window.localStorage.setItem(DOCK_OPEN_KEY, '1');
    const c = mount(<p id="dock-content">x</p>);
    expect(shellEl(c).getAttribute('data-dock')).toBe('open');
    expect(shellEl(c).getAttribute('style')).toContain('--dock-width: 490px');
    expect(aside(c)?.getAttribute('aria-label')).toBe('Agent Author');
    expect(c.querySelector('#dock-content')).not.toBeNull();
    const sep = separator(c);
    expect(sep.getAttribute('aria-valuenow')).toBe('490');
    expect(sep.getAttribute('aria-valuemin')).toBe('360');
    expect(sep.getAttribute('aria-valuemax')).toBe('640');
  });

  it('renders the shell exactly as before when no dock prop is passed', () => {
    window.localStorage.setItem(DOCK_OPEN_KEY, '1');
    const c = mount();
    expect(aside(c)).toBeNull();
    expect(shellEl(c).hasAttribute('data-dock')).toBe(false);
    expect(shellEl(c).style.getPropertyValue('--dock-width')).toBe('');
    expect(c.querySelector('#screen')).not.toBeNull();
  });

  it('restores a stored width', () => {
    window.localStorage.setItem(DOCK_OPEN_KEY, '1');
    window.localStorage.setItem(DOCK_WIDTH_KEY, '600');
    const c = mount(<p>x</p>);
    expect(separator(c).getAttribute('aria-valuenow')).toBe('600');
    expect(shellEl(c).getAttribute('style')).toContain('--dock-width: 600px');
  });

  it('resizes by 16px with the arrow keys and jumps to the limits with Home/End', () => {
    window.localStorage.setItem(DOCK_OPEN_KEY, '1');
    const c = mount(<p>x</p>);
    const sep = separator(c);
    key(sep, 'ArrowLeft');
    expect(sep.getAttribute('aria-valuenow')).toBe('506');
    expect(window.localStorage.getItem(DOCK_WIDTH_KEY)).toBe('506');
    key(sep, 'ArrowRight');
    expect(sep.getAttribute('aria-valuenow')).toBe('490');
    key(sep, 'Home');
    expect(sep.getAttribute('aria-valuenow')).toBe('360');
    expect(window.localStorage.getItem(DOCK_WIDTH_KEY)).toBe('360');
    key(sep, 'End');
    expect(sep.getAttribute('aria-valuenow')).toBe('640');
    expect(window.localStorage.getItem(DOCK_WIDTH_KEY)).toBe('640');
  });

  it('drags the handle to resize live and persists the width on release', () => {
    window.localStorage.setItem(DOCK_OPEN_KEY, '1');
    const c = mount(<p>x</p>);
    const sep = separator(c);
    pointer(sep, 'pointerdown', 1000);
    expect(sep.hasAttribute('data-dragging')).toBe(true);
    expect(shellEl(c).hasAttribute('data-dock-resizing')).toBe(true);
    pointer(sep, 'pointermove', 900);
    expect(sep.getAttribute('aria-valuenow')).toBe('590');
    expect(shellEl(c).getAttribute('style')).toContain('--dock-width: 590px');
    expect(window.localStorage.getItem(DOCK_WIDTH_KEY)).toBeNull(); // nothing stored mid-drag
    pointer(sep, 'pointerup', 900);
    expect(sep.hasAttribute('data-dragging')).toBe(false);
    expect(shellEl(c).hasAttribute('data-dock-resizing')).toBe(false);
    expect(window.localStorage.getItem(DOCK_WIDTH_KEY)).toBe('590');
  });

  it('closes on Escape inside the panel unless a child handler stopped it', () => {
    window.localStorage.setItem(DOCK_OPEN_KEY, '1');
    const c = mount(<p id="dock-content">x</p>);
    key(c.querySelector('#dock-content')!, 'Escape');
    expect(aside(c)).toBeNull();
    expect(window.localStorage.getItem(DOCK_OPEN_KEY)).toBe('0');

    window.localStorage.setItem(DOCK_OPEN_KEY, '1');
    const c2 = mount(
      <p id="dock-content" onKeyDown={(e) => e.preventDefault()}>
        x
      </p>,
    );
    key(c2.querySelector('#dock-content')!, 'Escape');
    expect(aside(c2)).not.toBeNull();
  });
});

describe('Dock narrow sheet', () => {
  it('opens as a right-side dialog sheet over a scrim; scrim click and Escape close it', () => {
    stubNarrow(true);
    window.localStorage.setItem(DOCK_OPEN_KEY, '1');
    const c = mount(<p id="dock-content">x</p>);
    const sheet = aside(c);
    expect(sheet?.className).toContain('dock-sheet');
    expect(sheet?.getAttribute('role')).toBe('dialog');
    expect(sheet?.getAttribute('aria-modal')).toBe('true');
    expect(c.querySelector('[role="separator"]')).toBeNull();
    const scrim = c.querySelector('.dock-scrim') as HTMLElement;
    expect(scrim).not.toBeNull();
    expect(scrim.getAttribute('aria-hidden')).toBe('true');
    act(() => scrim.click());
    expect(aside(c)).toBeNull();
    expect(window.localStorage.getItem(DOCK_OPEN_KEY)).toBe('0');

    window.localStorage.setItem(DOCK_OPEN_KEY, '1');
    const c2 = mount(<p id="dock-content">x</p>);
    key(c2.querySelector('#dock-content')!, 'Escape');
    expect(aside(c2)).toBeNull();
    expect(window.localStorage.getItem(DOCK_OPEN_KEY)).toBe('0');
  });
});

describe('useDock', () => {
  it('throws outside a DockProvider', () => {
    function Probe() {
      useDock();
      return null;
    }
    expect(() => render(<Probe />)).toThrow('useDock must be used inside a <DockProvider>.');
  });
});
