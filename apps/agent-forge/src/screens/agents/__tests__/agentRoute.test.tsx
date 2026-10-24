import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const appState = vi.hoisted(() => ({
  agentId: 'alpha',
  agents: [{ id: 'alpha' }, { id: 'beta' }] as { id: string }[],
  agentsLoaded: true,
  dirty: false,
  switchAgent: vi.fn<[string], Promise<void>>(() => Promise.resolve()),
}));
vi.mock('../../../state/AppState', () => ({ useAppState: () => appState }));

import { agentPath, agentRouteId, routeSyncAction } from '../agentRoute';
import { useAgentRouteSync } from '../useAgentRouteSync';
import { useLeaveAgentsGuard } from '../useLeaveAgentsGuard';
import { useScreen } from '../../routes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

function render(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}
const rerender = (node: React.ReactElement) => act(() => root!.render(node));

function go(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

// jsdom queues the hashchange of a location.replace() as a task.
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

let confirmSpy: MockInstance<[message?: string], boolean>;
beforeEach(() => {
  appState.agentId = 'alpha';
  appState.agents = [{ id: 'alpha' }, { id: 'beta' }];
  appState.agentsLoaded = true;
  appState.dirty = false;
  appState.switchAgent.mockReset();
  appState.switchAgent.mockImplementation(() => Promise.resolve());
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  confirmSpy.mockRestore();
  window.history.replaceState(null, '', '/');
});

describe('agentRouteId / agentPath', () => {
  it('reads the agent id from #/agents/:id only', () => {
    expect(agentRouteId('#/agents/support-bot')).toBe('support-bot');
    expect(agentRouteId('#/agents/a%20b')).toBe('a b');
    expect(agentRouteId('#/agents')).toBeUndefined();
    expect(agentRouteId('#/traces/abc')).toBeUndefined();
    expect(agentRouteId('')).toBeUndefined();
  });
  it('is #/agents/:id for a saved agent and bare #/agents for the unsaved default', () => {
    expect(agentPath('beta', [{ id: 'beta' }])).toBe('/agents/beta');
    expect(agentPath('untitled-agent', [])).toBe('/agents');
    expect(agentPath('new-one', [])).toBe('/agents/new-one');
  });
});

describe('routeSyncAction', () => {
  const agents = [{ id: 'alpha' }, { id: 'beta' }];
  it('does nothing without an id, before the list loads, or when the id is already open', () => {
    expect(routeSyncAction(undefined, 'alpha', agents, true)).toEqual({ kind: 'none' });
    expect(routeSyncAction('beta', 'alpha', [], false)).toEqual({ kind: 'none' });
    expect(routeSyncAction('alpha', 'alpha', agents, true)).toEqual({ kind: 'none' });
  });
  it('switches to a saved agent and falls back on an unknown one', () => {
    expect(routeSyncAction('beta', 'alpha', agents, true)).toEqual({ kind: 'switch', id: 'beta' });
    expect(routeSyncAction('gone', 'alpha', agents, true)).toEqual({ kind: 'fallback' });
  });
});

describe('useAgentRouteSync', () => {
  const Probe = () => {
    useAgentRouteSync();
    return null;
  };

  it('opens the agent the hash names', () => {
    window.history.replaceState(null, '', '/#/agents/beta');
    render(createElement(Probe));
    expect(appState.switchAgent).toHaveBeenCalledWith('beta');
  });

  it('replaces an unknown agent id with bare #/agents', () => {
    window.history.replaceState(null, '', '/#/agents/typo');
    const before = window.history.length;
    render(createElement(Probe));
    expect(window.location.hash).toBe('#/agents');
    expect(window.history.length).toBe(before);
    expect(appState.switchAgent).not.toHaveBeenCalled();
  });

  it('asks before switching away from unsaved changes, and restores the hash on cancel', async () => {
    window.history.replaceState(null, '', '/#/agents/alpha');
    appState.dirty = true;
    render(createElement(Probe));
    confirmSpy.mockReturnValue(false);
    go('#/agents/beta');
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(appState.switchAgent).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/agents/alpha');
    await flush();

    confirmSpy.mockReturnValue(true);
    go('#/agents/beta');
    expect(appState.switchAgent).toHaveBeenCalledWith('beta');
  });

  it('follows the open agent when it changes under the URL (create, rename, delete)', () => {
    window.history.replaceState(null, '', '/#/agents/alpha');
    render(createElement(Probe));
    appState.agentId = 'alpha-2';
    rerender(createElement(Probe));
    expect(window.location.hash).toBe('#/agents/alpha-2');
    expect(appState.switchAgent).not.toHaveBeenCalled();
  });

  it('leaves the URL alone on the initial load', () => {
    window.history.replaceState(null, '', '/#/agents');
    appState.agentsLoaded = false;
    appState.agentId = 'untitled-agent';
    render(createElement(Probe));
    appState.agentsLoaded = true;
    appState.agentId = 'alpha';
    rerender(createElement(Probe));
    expect(window.location.hash).toBe('#/agents');
  });
});

describe('useLeaveAgentsGuard', () => {
  function probe() {
    const seen: string[] = [];
    const Probe = () => {
      seen.push(useLeaveAgentsGuard(useScreen()));
      return null;
    };
    render(createElement(Probe));
    return seen;
  }

  it('leaves Agents without asking when nothing is unsaved', () => {
    window.history.replaceState(null, '', '/#/agents/alpha');
    const seen = probe();
    go('#/traces');
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(seen.at(-1)).toBe('traces');
  });

  it('asks before leaving Agents with unsaved changes; cancel restores the hash', async () => {
    window.history.replaceState(null, '', '/#/agents/alpha');
    appState.dirty = true;
    const seen = probe();
    confirmSpy.mockReturnValue(false);
    go('#/traces');
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('#/agents/alpha');
    expect(seen.at(-1)).toBe('agents');
    expect(seen).not.toContain('traces');
    await flush();
    expect(seen.at(-1)).toBe('agents');

    confirmSpy.mockReturnValue(true);
    go('#/settings');
    expect(seen.at(-1)).toBe('settings');
  });

  it('does not ask between non-Agents screens', () => {
    window.history.replaceState(null, '', '/#/traces');
    appState.dirty = true;
    const seen = probe();
    go('#/monitoring');
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(seen.at(-1)).toBe('monitoring');
  });
});
