import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord, Requirement } from '../../../../shared/wireTypes';
import { render } from '../../../ui/__tests__/render';

const mocks = vi.hoisted(() => {
  class MockRuntimeApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
      this.name = 'RuntimeApiError';
    }
  }
  return { loadAgent: vi.fn(), MockRuntimeApiError };
});

vi.mock('../../../runtime/runtimeClient', () => ({
  runtimeClient: { loadAgent: mocks.loadAgent },
  RuntimeApiError: mocks.MockRuntimeApiError,
}));

import { AgentDetailRoute } from '../AgentDetailRoute';

function meta(over: Partial<AgentRecord['meta']> = {}): AgentRecord['meta'] {
  return {
    schemaVersion: 1,
    enabled: true,
    disabledAt: null,
    disabledReason: null,
    failureStreak: 0,
    labels: [],
    publishedVersion: null,
    createdAt: '2026-10-29T09:00:00Z',
    updatedAt: '2026-10-29T09:00:00Z',
    ...over,
  };
}

function record(over: { spec?: Partial<AgentRecord['spec']>; meta?: Partial<AgentRecord['meta']>; requirements?: Requirement[] } = {}): AgentRecord {
  return {
    id: 'support-bot',
    spec: {
      version: 2,
      name: 'Support bot',
      description: 'Answers billing questions.',
      model: 'anthropic/claude-sonnet-5-5',
      instructions: 'Be helpful.',
      ...over.spec,
    },
    meta: meta(over.meta),
    layout: { schemaVersion: 1, nodes: {}, notes: [] },
    updatedAt: '2026-10-29T10:00:00Z',
    latestVersion: null,
    requirements: over.requirements,
  };
}

/** Flushes the loadAgent promise and applies the state updates inside act. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function go(hash: string) {
  window.location.hash = hash;
}

beforeEach(() => {
  mocks.loadAgent.mockReset();
  window.location.hash = '';
});

describe('AgentDetailRoute', () => {
  it('shows a loading status while the record is in flight', () => {
    mocks.loadAgent.mockReturnValue(new Promise(() => {}));
    go('#/agents/support-bot/overview');
    const host = render(<AgentDetailRoute />);
    const status = host.querySelector('[role="status"]');
    expect(status?.textContent).toBe('Loading agent');
  });

  it('renders the header, badge, Test link and tab strip for a loaded agent', async () => {
    mocks.loadAgent.mockResolvedValue(record());
    go('#/agents/support-bot/overview');
    const host = render(<AgentDetailRoute />);
    await flush();

    expect(host.querySelector('h1.agent-detail-name')?.textContent).toBe('Support bot');
    expect(host.querySelector('.page-header-crumbs a')?.getAttribute('href')).toBe('#/agents');
    expect(host.querySelector('.status-badge-label')?.textContent).toBe('Not published');

    const test = host.querySelector<HTMLAnchorElement>('a.btn-primary');
    expect(test?.textContent?.trim()).toBe('Test');
    expect(test?.getAttribute('href')).toBe('#/agents/support-bot/canvas?test=1');

    const tabs = host.querySelector('nav[aria-label="Agent"]')!;
    expect(tabs.querySelector('[data-tab-id="overview"]')?.getAttribute('aria-current')).toBe('page');
    const configure = tabs.querySelector('[data-tab-id="configure"]')!;
    expect(configure.tagName).toBe('SPAN');
    expect(configure.getAttribute('aria-disabled')).toBe('true');
    expect(configure.getAttribute('title')).toBe('Coming in a later release');
  });

  it('shows the published badge with the version number', async () => {
    mocks.loadAgent.mockResolvedValue(record({ meta: { publishedVersion: 3 } }));
    go('#/agents/support-bot/overview');
    const host = render(<AgentDetailRoute />);
    await flush();
    expect(host.querySelector('.status-badge-label')?.textContent).toBe('Published v3');
  });

  it('clamps a long description behind Show more / Show less', async () => {
    const long = 'x'.repeat(200);
    mocks.loadAgent.mockResolvedValue(record({ spec: { description: long } }));
    go('#/agents/support-bot/overview');
    const host = render(<AgentDetailRoute />);
    await flush();

    const more = host.querySelector<HTMLButtonElement>('button.agent-detail-more')!;
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(more.textContent).toBe('Show more');
    expect(host.querySelector('.agent-detail-description')?.classList.contains('is-expanded')).toBe(false);

    act(() => more.click());
    expect(more.textContent).toBe('Show less');
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.agent-detail-description')?.classList.contains('is-expanded')).toBe(true);
  });

  it('offers no Show more for a short description', async () => {
    mocks.loadAgent.mockResolvedValue(record());
    go('#/agents/support-bot/overview');
    const host = render(<AgentDetailRoute />);
    await flush();
    expect(host.querySelector('button.agent-detail-more')).toBeNull();
  });

  it('links a missing requirement to its fix and collapses an all-ok list to Ready to run', async () => {
    const requirements: Requirement[] = [
      { id: 'provider:anthropic', kind: 'provider_key', status: 'missing', label: 'Anthropic API key', fix: { action: 'add_secret', target: 'anthropic' } },
      { id: 'model:x', kind: 'model', status: 'ok', label: 'Model x' },
    ];
    mocks.loadAgent.mockResolvedValue(record({ requirements }));
    go('#/agents/support-bot/overview');
    const host = render(<AgentDetailRoute />);
    await flush();

    const chip = host.querySelector<HTMLAnchorElement>('a.readiness-chip.readiness-missing')!;
    expect(chip.getAttribute('href')).toBe('#/settings');
    expect(chip.textContent).toContain('Anthropic API key');
    expect(host.querySelectorAll('.readiness-chip').length).toBe(1);
  });

  it('shows one Ready to run chip when every requirement is ok', async () => {
    mocks.loadAgent.mockResolvedValue(
      record({ requirements: [{ id: 'm', kind: 'model', status: 'ok', label: 'Model' }] }),
    );
    go('#/agents/support-bot/overview');
    const host = render(<AgentDetailRoute />);
    await flush();

    const chips = host.querySelectorAll('.readiness-chip');
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toContain('Ready to run');
    expect(chips[0].classList.contains('readiness-ok')).toBe(true);
  });

  it('renders no readiness chips when the record has no requirements', async () => {
    mocks.loadAgent.mockResolvedValue(record());
    go('#/agents/support-bot/overview');
    const host = render(<AgentDetailRoute />);
    await flush();
    expect(host.querySelector('.readiness-chips')).toBeNull();
  });

  it('shows Agent not found on a 404', async () => {
    mocks.loadAgent.mockRejectedValue(new mocks.MockRuntimeApiError('not found', 404));
    go('#/agents/nope/overview');
    const host = render(<AgentDetailRoute />);
    await flush();
    expect(host.textContent).toContain('Agent not found');
    expect(host.textContent).toContain('No agent called “nope” in this workspace.');
    expect(host.querySelector('.empty-state a.btn')?.getAttribute('href')).toBe('#/agents');
  });

  it('shows a retryable error on other failures', async () => {
    mocks.loadAgent.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(record());
    go('#/agents/support-bot/overview');
    const host = render(<AgentDetailRoute />);
    await flush();

    expect(host.textContent).toContain('Could not load this agent');
    expect(host.textContent).toContain('boom');
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    act(() => retry.click());
    await flush();
    expect(mocks.loadAgent).toHaveBeenCalledTimes(2);
    expect(host.querySelector('h1.agent-detail-name')?.textContent).toBe('Support bot');
  });

  it('cuts the instructions card at 12 lines with a more-lines note', async () => {
    const instructions = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\n');
    mocks.loadAgent.mockResolvedValue(record({ spec: { instructions } }));
    go('#/agents/support-bot/overview');
    const host = render(<AgentDetailRoute />);
    await flush();

    const pre = host.querySelector('pre.agent-overview-instructions')!;
    expect(pre.textContent?.split('\n').length).toBe(12);
    expect(host.querySelector('.agent-overview-more')?.textContent).toBe('3 more lines');
    expect(host.querySelector('.agent-overview a.btn-ghost')?.getAttribute('href')).toBe('#/agents/support-bot/canvas');
  });

  it('names the prompt file when instructions is a { file } ref', async () => {
    mocks.loadAgent.mockResolvedValue(record({ spec: { instructions: { file: 'prompts/support.md' } } }));
    go('#/agents/support-bot/overview');
    const host = render(<AgentDetailRoute />);
    await flush();
    expect(host.textContent).toContain('Loaded from prompts/support.md');
  });
});
