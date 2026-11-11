import { describe, expect, it, vi } from 'vitest';

import { render } from '../../../ui/__tests__/render';

const appState = vi.hoisted(() => ({
  agentId: 'untitled-agent',
  agents: [] as { id: string }[],
}));
vi.mock('../../../state/AppState', () => ({ useAppState: () => appState }));

import { BuilderTabs } from '../BuilderTabs';

describe('BuilderTabs', () => {
  it('shows the agent tabs with Canvas current for a saved agent', () => {
    appState.agentId = 'support-bot';
    appState.agents = [{ id: 'support-bot' }];
    const host = render(<BuilderTabs />);

    const nav = host.querySelector('nav[aria-label="Agent"]')!;
    expect(nav).not.toBeNull();
    const canvas = nav.querySelector('[data-tab-id="canvas"]')!;
    expect(canvas.getAttribute('aria-current')).toBe('page');
    expect(canvas.getAttribute('href')).toBe('#/agents/support-bot/canvas');
    // Unbuilt tabs stay disabled placeholders, as on the detail header.
    const suggestions = nav.querySelector('[data-tab-id="suggestions"]')!;
    expect(suggestions.tagName).toBe('SPAN');
    expect(suggestions.getAttribute('aria-disabled')).toBe('true');
    const configure = nav.querySelector<HTMLAnchorElement>('[data-tab-id="configure"]')!;
    expect(configure.tagName).toBe('A');
    expect(configure.getAttribute('href')).toBe('#/agents/support-bot/configure');
  });

  it('renders nothing for the unsaved default agent', () => {
    appState.agentId = 'untitled-agent';
    appState.agents = [];
    const host = render(<BuilderTabs />);
    expect(host.innerHTML).toBe('');
    expect(host.querySelector('nav')).toBeNull();
  });
});
