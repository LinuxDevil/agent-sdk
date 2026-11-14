import { describe, expect, it } from 'vitest';

import type { ObservedAgentItem } from '../../../../shared/wireTypes';
import { ObservedAgentCard } from '../ObservedAgentCard';
import { render } from '../../../ui/__tests__/render';

const NOW = Date.parse('2026-10-29T12:00:00Z');

const agent = (over: Partial<ObservedAgentItem> = {}): ObservedAgentItem => ({
  kind: 'observed',
  id: '3f6b2a1c-9d4e-4f5a-8b7c-1d2e3f4a5b6c',
  name: 'billing-worker',
  project: 'billing-svc',
  workspaceId: 'alpha-1a2b3c',
  instances: 2,
  status: 'healthy',
  lastSeenAt: '2026-10-29T11:59:00Z',
  runsToday: 14,
  errorRateToday: 0.02,
  ...over,
});

function mount(item: ObservedAgentItem, workspaceName?: string) {
  return render(<ObservedAgentCard agent={item} workspaceName={workspaceName} now={NOW} />);
}

describe('ObservedAgentCard', () => {
  it('renders name, project, instances, status label and footer facts', () => {
    const host = mount(agent());
    const card = host.querySelector('article.agent-card--observed')!;
    expect(card.textContent).toContain('billing-worker');
    expect(card.textContent).toContain('billing-svc');
    expect(card.textContent).toContain('2 instances');
    expect(card.textContent).toContain('Healthy');
    expect(card.textContent).toContain('Observed');
    expect(card.textContent).toContain('14 runs today');
    expect(card.textContent).toContain('Last seen');
  });

  it('uses the singular for one instance and one run', () => {
    const host = mount(agent({ instances: 1, runsToday: 1 }));
    expect(host.textContent).toContain('1 instance');
    expect(host.textContent).toContain('1 run today');
    expect(host.textContent).not.toContain('1 instances');
  });

  it('shows each status label', () => {
    for (const [status, label] of [
      ['stale', 'Stale'],
      ['down', 'Down'],
      ['stopped', 'Stopped'],
    ] as const) {
      const host = mount(agent({ status }));
      expect(host.textContent).toContain(label);
    }
  });

  it('shows "No project" when the daemon reported none', () => {
    const host = mount(agent({ project: null }));
    expect(host.textContent).toContain('No project');
  });

  it('links the whole card to the observed page with an "observed agent" aria-label', () => {
    const host = mount(agent());
    const link = host.querySelector<HTMLAnchorElement>('.agent-card-link')!;
    expect(link.getAttribute('href')).toBe('#/observed/3f6b2a1c-9d4e-4f5a-8b7c-1d2e3f4a5b6c');
    expect(link.getAttribute('aria-label')).toBe('billing-worker, observed agent');
    expect(host.querySelector('[role="switch"]')).toBeNull();
  });

  it('renders the workspace chip only when a workspace name is given', () => {
    const named = mount(agent(), 'Alpha');
    expect(named.querySelector('.agent-card-workspace')?.textContent).toContain('Alpha');
    const bare = mount(agent());
    expect(bare.querySelector('.agent-card-workspace')).toBeNull();
  });
});
