import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({
  spec: { name: 'demo', provider: { type: 'mock', model: 'echo' } },
  agentId: 'demo',
  dirty: false,
  runStatus: undefined,
  debugMode: false,
  setDebugMode: () => {},
  setDrawerTab: () => {},
  runAgent: async () => {},
  stopAgent: async () => {},
  save: async () => {},
  setSpec: () => {},
  activeProfile: undefined,
  connected: true,
}));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

import { screenFor, useScreen } from '../routes';
import { Placeholder } from '../Placeholder';
import { Topbar } from '../../components/Topbar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

function render(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

function go(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

const buttonNames = () => [...container.querySelectorAll('button')].map((b) => b.textContent?.trim());

beforeEach(() => {
  window.history.replaceState(null, '', '/?token=secret');
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  window.history.replaceState(null, '', '/');
});

describe('screenFor', () => {
  it('maps every nav destination and its deep links to a screen', () => {
    expect(screenFor('#/agents')).toBe('agents');
    expect(screenFor('#/agents/support-bot')).toBe('agents');
    expect(screenFor('#/traces')).toBe('traces');
    expect(screenFor('#/traces/abc?obs=1')).toBe('trace');
    expect(screenFor('#/monitoring?window=24h')).toBe('monitoring');
    expect(screenFor('#/evals/scores')).toBe('scores');
    expect(screenFor('#/evals/datasets')).toBe('evals');
    expect(screenFor('#/playground')).toBe('playground');
    expect(screenFor('#/threads/s1')).toBe('threads');
    expect(screenFor('#/prompts/greeting@v2')).toBe('prompts');
    expect(screenFor('#/hub/docs')).toBe('hub');
    expect(screenFor('#/settings')).toBe('settings');
  });
  it('has no screen for an empty hash or an unknown route', () => {
    expect(screenFor('')).toBeNull();
    expect(screenFor('#/')).toBeNull();
    expect(screenFor('#/nope')).toBeNull();
  });
});

describe('useScreen', () => {
  function probe() {
    const seen: string[] = [];
    const Probe = () => {
      seen.push(useScreen());
      return null;
    };
    render(createElement(Probe));
    return seen;
  }

  it('redirects an empty hash to #/agents with replace, keeping ?token=', () => {
    const before = window.history.length;
    const seen = probe();
    expect(window.location.hash).toBe('#/agents');
    expect(window.location.search).toBe('?token=secret');
    expect(window.history.length).toBe(before);
    expect(seen.every((s) => s === 'agents')).toBe(true);
  });

  it('redirects an unknown route to #/agents, keeping ?token=', () => {
    window.history.replaceState(null, '', '/?token=secret#/nope');
    probe();
    expect(window.location.hash).toBe('#/agents');
    expect(window.location.search).toBe('?token=secret');
  });

  it('follows hash changes', () => {
    window.history.replaceState(null, '', '/?token=secret#/traces');
    const seen = probe();
    expect(seen.at(-1)).toBe('traces');
    go('#/monitoring');
    expect(seen.at(-1)).toBe('monitoring');
  });
});

describe('Topbar', () => {
  it('shows the Build controls on #/agents', () => {
    window.history.replaceState(null, '', '/?token=secret#/agents');
    render(<Topbar />);
    expect(buttonNames()).toEqual(expect.arrayContaining(['Run', 'Stop', 'Import', 'Export', 'Save', 'Debug']));
    expect(container.querySelector('.env-select')).not.toBeNull();
  });

  it('has no Build controls or model badge on #/traces', () => {
    window.history.replaceState(null, '', '/?token=secret#/traces');
    render(<Topbar />);
    for (const name of ['Run', 'Stop', 'Import', 'Export', 'Save', 'Debug', 'Build', 'Observe']) {
      expect(buttonNames()).not.toContain(name);
    }
    expect(container.querySelector('.env-select')).toBeNull();
    expect(container.querySelector('.mock-badge')).toBeNull();
    expect(container.querySelector('header')?.textContent).toContain('Traces');
    expect(container.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
  });

  it('has no Build controls in the narrow layout off Agents either', () => {
    window.history.replaceState(null, '', '/?token=secret#/monitoring');
    render(<Topbar narrow />);
    expect(buttonNames()).not.toContain('Run');
    expect(container.querySelector('[aria-label="More actions"]')).toBeNull();
  });

  it('drops the Build/Observe switch on #/agents', () => {
    window.history.replaceState(null, '', '/?token=secret#/agents');
    render(<Topbar />);
    expect(container.querySelector('[aria-label="Studio surface"]')).toBeNull();
    expect(buttonNames()).not.toContain('Observe');
  });

  it("maps the old 'Observe surface' shortcut to #/traces", () => {
    window.history.replaceState(null, '', '/?token=secret#/agents');
    render(<Topbar narrow />);
    act(() => (container.querySelector('[aria-label="More actions"]') as HTMLButtonElement).click());
    const item = [...container.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent === 'Observe surface',
    ) as HTMLButtonElement;
    act(() => item.click());
    expect(window.location.hash).toBe('#/traces');
    expect(window.location.search).toBe('?token=secret');
  });
});

describe('Placeholder', () => {
  it('shows a title, what is coming, and a link back to Agents', () => {
    render(<Placeholder title="Playground" blurb="Coming soon." />);
    expect(container.querySelector('h2')?.textContent).toBe('Playground');
    expect(container.textContent).toContain('Coming soon.');
    expect(container.querySelector('a[href="#/agents"]')).not.toBeNull();
  });
});
