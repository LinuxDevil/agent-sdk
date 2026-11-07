import { beforeEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({
  agents: [] as { id: string; spec: { name: string } }[],
  agentsLoaded: true,
  runStatus: undefined,
}));
vi.mock('../../../state/AppState', () => ({ useAppState: () => appState }));

import { AgentListScreen } from '../AgentListScreen';
import { render } from '../../../ui/__tests__/render';

beforeEach(() => {
  appState.agents = [];
  appState.agentsLoaded = true;
  window.history.replaceState(null, '', '/#/agents');
});

describe('AgentListScreen', () => {
  it('offers the builder when the workspace has no agents yet', () => {
    const host = render(<AgentListScreen />);
    expect(host.textContent).toContain('No agents yet');
    const action = host.querySelector<HTMLAnchorElement>('.empty-state a.btn-primary');
    expect(action?.getAttribute('href')).toBe('#/agents/untitled-agent/canvas');
  });

  it('links every agent to its overview tab', () => {
    appState.agents = [
      { id: 'alpha', spec: { name: 'Alpha' } },
      { id: 'beta', spec: { name: 'Beta bot' } },
    ];
    const host = render(<AgentListScreen />);
    const links = [...host.querySelectorAll<HTMLAnchorElement>('.agent-list-placeholder a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['#/agents/alpha/overview', '#/agents/beta/overview']);
    expect(links.map((a) => a.textContent)).toEqual(['Alpha', 'Beta bot']);
  });
});
