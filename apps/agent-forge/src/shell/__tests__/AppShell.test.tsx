import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({ connected: true }));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

import { AppShell } from '../AppShell';
import { NAV_ITEMS, isActive } from '../NavRail';

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
      <AppShell>
        <p id="screen">screen</p>
      </AppShell>,
    ),
  );
}

const nav = () => container.querySelector('nav[aria-label="Primary"]') as HTMLElement;
const toggle = () => container.querySelector('button[aria-controls="primary-nav"]') as HTMLButtonElement | null;

beforeEach(() => {
  appState.connected = true;
  window.location.hash = '#/traces';
});
afterEach(() => {
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
