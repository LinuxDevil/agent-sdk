/**
 * L13 - the Agents list's Labels facet end to end: options come from
 * `labelFacetOptions` (sorted, with counts), selection filters with OR
 * semantics, the selection lives in `?labels=` (selection order) and an
 * empty result offers Clear filters.
 */
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../state/AppState', () => ({ useAppState: () => ({ runStatus: null }) }));

const api = vi.hoisted(() => ({
  listAgents: vi.fn(),
  patchAgentMeta: vi.fn(),
  createAgentRecord: vi.fn(),
}));
vi.mock('../../../runtime/runtimeClient', () => ({ runtimeClient: api }));

import type { AgentListItem, AgentRecord } from '../../../../shared/wireTypes';
import { AgentListScreen } from '../AgentListScreen';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';

const item = (over: Partial<AgentListItem>): AgentListItem => ({
  id: 'agent',
  name: 'Agent',
  description: '',
  model: 'anthropic/claude-sonnet-5-5',
  enabled: true,
  labels: [],
  updatedAt: '2026-10-29T11:00:00Z',
  publishedVersion: null,
  counts: { tools: 0, mcpServers: 0, subagents: 0, triggers: 0 },
  ...over,
});

const ITEMS: AgentListItem[] = [
  item({ id: 'support-bot', name: 'Support bot', labels: ['billing', 'billing ops'], enabled: true }),
  item({ id: 'pr-reviewer', name: 'PR reviewer', labels: ['github', 'billing'], enabled: false }),
  item({ id: 'docs-qa', name: 'Docs QA', labels: ['ops'], enabled: true }),
];

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountAt(hash = '#/agents') {
  window.history.replaceState(null, '', `/${hash}`);
  const host = render(
    <ToastProvider>
      <AgentListScreen />
    </ToastProvider>
  );
  await flush();
  return host;
}

const cardNames = (host: HTMLElement) =>
  [...host.querySelectorAll('article.agent-card h3')].map((h) => h.textContent);

const facetButton = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLButtonElement>('.facet-btn')].find((b) => b.textContent?.startsWith('Labels'))!;

const optionInput = (labelText: string) => {
  const opt = [...document.querySelectorAll<HTMLLabelElement>('.facet-opt')].find((el) =>
    el.textContent?.includes(labelText)
  )!;
  return opt.querySelector<HTMLInputElement>('input')!;
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listAgents.mockResolvedValue(ITEMS);
  api.patchAgentMeta.mockResolvedValue({});
  api.createAgentRecord.mockResolvedValue({ id: 'untitled-1' } as AgentRecord);
  window.history.replaceState(null, '', '/#/agents');
});

describe('Agents list Labels facet (L13)', () => {
  it('offers every label sorted alphabetically with agent counts', async () => {
    const host = await mountAt();
    await act(async () => facetButton(host).click());
    const rows = [...document.querySelectorAll('.facet-opt')].map((el) => ({
      label: el.querySelector('span')?.textContent,
      count: el.querySelector('.facet-opt-count')?.textContent,
    }));
    expect(rows).toEqual([
      { label: 'billing', count: '2' },
      { label: 'billing ops', count: '1' },
      { label: 'github', count: '1' },
      { label: 'ops', count: '1' },
    ]);
  });

  it('filters with OR semantics and writes the selection to ?labels= in click order', async () => {
    const host = await mountAt();
    await act(async () => facetButton(host).click());
    await act(async () => optionInput('github').click());
    // The facet's value prop only updates after the hashchange round-trips.
    await flush();
    await act(async () => optionInput('billing').click());
    await flush();

    // OR: agents carrying github OR billing (billing ops does not count as billing).
    expect(cardNames(host)).toEqual(['PR reviewer', 'Support bot']);
    expect(window.location.hash).toContain('labels=');
    const query = new URLSearchParams(window.location.hash.split('?')[1]);
    expect(query.get('labels')).toBe('github,billing');
  });

  it('restores the filter from the URL on load', async () => {
    const host = await mountAt('#/agents?labels=billing%20ops');
    expect(cardNames(host)).toEqual(['Support bot']);
  });

  it('shows the no-match state and Clear filters restores the URL and the cards', async () => {
    const host = await mountAt('#/agents?labels=missing');
    expect(host.textContent).toContain('No agents match these filters');
    expect(host.textContent).toContain('Clear a filter to see more agents.');
    const clear = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Clear filters')!;
    await act(async () => clear.click());
    await flush();
    expect(window.location.hash).toBe('#/agents');
    expect(host.querySelectorAll('article.agent-card')).toHaveLength(3);
  });
});
