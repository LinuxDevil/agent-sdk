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
import { ToastProvider } from '../../../ui/Toast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

function render(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(ToastProvider, null, node)));
}
const rerender = (node: React.ReactElement) => act(() => root!.render(createElement(ToastProvider, null, node)));

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
  it('reads the agent id from every agents URL that names one', () => {
    expect(agentRouteId('#/agents/support-bot')).toBe('support-bot');
    expect(agentRouteId('#/agents/support-bot/canvas')).toBe('support-bot');
    expect(agentRouteId('#/agents/support-bot/runs')).toBe('support-bot');
    expect(agentRouteId('#/agents/a%20b')).toBe('a b');
    expect(agentRouteId('#/agents')).toBeUndefined();
    expect(agentRouteId('#/traces/abc')).toBeUndefined();
    expect(agentRouteId('')).toBeUndefined();
  });
  it('is the canvas URL for every agent, including the unsaved default', () => {
    expect(agentPath('beta')).toBe('/agents/beta/canvas');
    expect(agentPath('untitled-agent')).toBe('/agents/untitled-agent/canvas');
    expect(agentPath('a b')).toBe('/agents/a%20b/canvas');
  });
});

describe('routeSyncAction', () => {
  const agents = [{ id: 'alpha' }, { id: 'beta' }];
  it('does nothing without an id, before the list loads, or when the id is already open', () => {
    expect(routeSyncAction(undefined, 'alpha', [], true)).toEqual({ kind: 'none' });
    expect(routeSyncAction(undefined, 'alpha', agents, false)).toEqual({ kind: 'none' });
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
    window.history.replaceState(null, '', '/#/agents/beta/canvas');
    render(createElement(Probe));
    expect(appState.switchAgent).toHaveBeenCalledWith('beta');
  });

  it('replaces an unknown agent id with #/agents (the list) and leaves it there', async () => {
    window.history.replaceState(null, '', '/#/agents/typo/canvas');
    const before = window.history.length;
    render(createElement(Probe));
    expect(window.location.hash).toBe('#/agents');
    await flush();
    expect(window.location.hash).toBe('#/agents');
    expect(window.history.length).toBe(before);
    expect(appState.switchAgent).not.toHaveBeenCalled();
  });

  it('leaves bare #/agents (the list) alone', () => {
    window.history.replaceState(null, '', '/#/agents');
    render(createElement(Probe));
    expect(window.location.hash).toBe('#/agents');
    expect(appState.switchAgent).not.toHaveBeenCalled();
  });

  it('leaves a non-Agents hash alone (a move off Agents held for the prompt)', () => {
    window.history.replaceState(null, '', '/#/traces');
    render(createElement(Probe));
    expect(window.location.hash).toBe('#/traces');
  });

  it('reports a failed open as an error toast and falls back to the list', async () => {
    appState.switchAgent.mockImplementation(() => Promise.reject(new Error('not found')));
    window.history.replaceState(null, '', '/#/agents/beta/canvas');
    render(createElement(Probe));
    await act(async () => {});
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not open agent beta: not found');
    await flush();
    expect(window.location.hash).toBe('#/agents');
  });

  it('asks before switching away from unsaved changes, and restores the hash on cancel', async () => {
    window.history.replaceState(null, '', '/#/agents/alpha/canvas');
    appState.dirty = true;
    render(createElement(Probe));
    confirmSpy.mockReturnValue(false);
    go('#/agents/beta/canvas');
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(appState.switchAgent).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/agents/alpha/canvas');
    await flush();

    confirmSpy.mockReturnValue(true);
    go('#/agents/beta/canvas');
    expect(appState.switchAgent).toHaveBeenCalledWith('beta');
  });

  it('follows the open agent when it changes under the URL (create, rename, delete)', () => {
    window.history.replaceState(null, '', '/#/agents/alpha/canvas');
    render(createElement(Probe));
    appState.agentId = 'alpha-2';
    rerender(createElement(Probe));
    expect(window.location.hash).toBe('#/agents/alpha-2/canvas');
    expect(appState.switchAgent).not.toHaveBeenCalled();
  });

  it('opens the agent the hash names once the saved list has loaded', () => {
    window.history.replaceState(null, '', '/#/agents/beta/canvas');
    appState.agentsLoaded = false;
    render(createElement(Probe));
    expect(appState.switchAgent).not.toHaveBeenCalled();
    appState.agentsLoaded = true;
    rerender(createElement(Probe));
    expect(appState.switchAgent).toHaveBeenCalledWith('beta');
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
    window.history.replaceState(null, '', '/#/agents/alpha/canvas');
    const seen = probe();
    go('#/traces');
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(seen.at(-1)).toBe('traces');
  });

  it('asks before leaving Agents with unsaved changes; cancel restores the hash', async () => {
    window.history.replaceState(null, '', '/#/agents/alpha/canvas');
    appState.dirty = true;
    const seen = probe();
    confirmSpy.mockReturnValue(false);
    go('#/traces');
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('#/agents/alpha/canvas');
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
