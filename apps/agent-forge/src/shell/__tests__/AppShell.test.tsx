import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({ connected: true, agents: [], switchAgent: () => Promise.resolve() }));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

import { AppShell } from '../AppShell';
import { ToastProvider } from '../../ui/Toast';
import { NAV_ITEMS, isActive } from '../NavRail';
import { breakStorage, installMemoryStorage } from '../../ui/__tests__/memoryStorage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

function stubNarrow(narrow: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: narrow,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <ToastProvider>
        <AppShell>
          <p id="screen">screen</p>
        </AppShell>
      </ToastProvider>,
    ),
  );
}

const nav = () => container.querySelector('nav[aria-label="Primary"]') as HTMLElement;
const toggle = () => container.querySelector('button[aria-label="Navigation"]') as HTMLButtonElement | null;
const collapseToggle = () => container.querySelector('button.nav-collapse') as HTMLButtonElement | null;
const shellEl = () => container.querySelector('.app-shell') as HTMLElement;

beforeEach(() => {
  appState.connected = true;
  window.location.hash = '#/traces';
  installMemoryStorage();
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => root?.unmount());
  container.remove();
  root = undefined;
});

describe('AppShell', () => {
  it('renders the 9 nav items in order and the screen', () => {
    stubNarrow(false);
    render();
    const links = [...nav().querySelectorAll('a')];
    expect(links.map((a) => a.textContent)).toEqual([
      'Agents',
      'Playground',
      'Traces',
      'Threads',
      'Monitoring',
      'Evaluations',
      'Prompts',
      'Context Hub',
      'Settings',
    ]);
    expect(NAV_ITEMS.map((i) => i.href)).toEqual([
      '#/agents',
      '#/playground',
      '#/traces',
      '#/threads',
      '#/monitoring',
      '#/evals/scores',
      '#/prompts',
      '#/hub',
      '#/settings',
    ]);
    expect(container.querySelector('#screen')).not.toBeNull();
    expect(toggle()).toBeNull();
  });

  it('marks only the active route aria-current=page, following hash changes', () => {
    stubNarrow(false);
    render();
    const current = () => [...nav().querySelectorAll('a[aria-current="page"]')].map((a) => a.textContent);
    expect(current()).toEqual(['Traces']);
    act(() => {
      window.location.hash = '#/evals/datasets';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(current()).toEqual(['Evaluations']);
    act(() => {
      window.location.hash = '#/traces/abc?obs=1';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(current()).toEqual(['Traces']);
  });

  it('shows the connection banner when the studio server drops', () => {
    stubNarrow(false);
    appState.connected = false;
    render();
    expect(container.querySelector('.connection-banner')?.getAttribute('role')).toBe('alert');
  });

  it('collapses to a drawer when narrow: toggle, Escape, scrim and link close it', () => {
    stubNarrow(true);
    render();
    expect(nav().getAttribute('data-drawer')).toBe('closed');
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle()!.click());
    expect(nav().getAttribute('data-drawer')).toBe('open');
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(nav().getAttribute('data-drawer')).toBe('closed');
    act(() => toggle()!.click());
    act(() => (container.querySelector('.app-shell-scrim') as HTMLElement).click());
    expect(nav().getAttribute('data-drawer')).toBe('closed');
    act(() => toggle()!.click());
    act(() => (nav().querySelector('a') as HTMLElement).click());
    expect(nav().getAttribute('data-drawer')).toBe('closed');
  });
});

describe('collapsible icon rail', () => {
  it('toggles with aria-expanded and labels, and persists across a remount', () => {
    stubNarrow(false);
    render();
    expect(nav().hasAttribute('data-collapsed')).toBe(false);
    expect(collapseToggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(collapseToggle()?.getAttribute('aria-label')).toBe('Collapse navigation');
    expect(collapseToggle()?.getAttribute('aria-controls')).toBe('primary-nav');
    act(() => collapseToggle()!.click());
    expect(nav().hasAttribute('data-collapsed')).toBe(true);
    expect(shellEl().getAttribute('data-nav')).toBe('collapsed');
    expect(collapseToggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(collapseToggle()?.getAttribute('aria-label')).toBe('Expand navigation');
    expect(window.localStorage.getItem('forge.nav.collapsed')).toBe('1');

    act(() => root?.unmount());
    container.remove();
    render();
    expect(nav().hasAttribute('data-collapsed')).toBe(true);
    act(() => collapseToggle()!.click());
    expect(nav().hasAttribute('data-collapsed')).toBe(false);
    expect(window.localStorage.getItem('forge.nav.collapsed')).toBe('0');
  });

  it('keeps every item reachable by its accessible name when collapsed', () => {
    stubNarrow(false);
    window.localStorage.setItem('forge.nav.collapsed', '1');
    render();
    expect(nav().hasAttribute('data-collapsed')).toBe(true);
    for (const item of NAV_ITEMS) {
      const link = nav().querySelector(`a[href="${item.href}"]`) as HTMLAnchorElement;
      expect(link.getAttribute('aria-label')).toBe(item.label);
      expect(link.getAttribute('title')).toBe(item.label);
    }
    expect(nav().querySelectorAll('.nav-heading')).toHaveLength(0);
    expect(nav().querySelectorAll('.nav-divider')).toHaveLength(4);
    expect(nav().querySelector('.nav-wordmark')).toBeNull();
    expect(nav().querySelector('.logo-mark')).not.toBeNull();
  });

  it('is ignored in the narrow drawer, which has no collapse toggle', () => {
    stubNarrow(true);
    window.localStorage.setItem('forge.nav.collapsed', '1');
    render();
    expect(collapseToggle()).toBeNull();
    expect(nav().hasAttribute('data-collapsed')).toBe(false);
    expect(shellEl().hasAttribute('data-nav')).toBe(false);
    expect(nav().querySelectorAll('.nav-heading')).toHaveLength(4);
  });

  it('survives storage that throws', () => {
    stubNarrow(false);
    breakStorage();
    render();
    expect(nav().hasAttribute('data-collapsed')).toBe(false);
    act(() => collapseToggle()!.click());
    expect(nav().hasAttribute('data-collapsed')).toBe(true);
  });
});

describe('isActive', () => {
  const item = (id: string) => NAV_ITEMS.find((i) => i.id === id)!;
  it('owns every route under its first segment; the bare / is Agents', () => {
    expect(isActive(item('evals'), '/evals/datasets')).toBe(true);
    expect(isActive(item('traces'), '/traces/abc')).toBe(true);
    expect(isActive(item('agents'), '/')).toBe(true);
    expect(isActive(item('traces'), '/')).toBe(false);
    expect(isActive(item('threads'), '/traces')).toBe(false);
  });
});
