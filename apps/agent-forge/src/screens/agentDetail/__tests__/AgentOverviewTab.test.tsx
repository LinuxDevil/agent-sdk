import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord, Requirement, TraceSummaryPayload } from '../../../../shared/wireTypes';
import { render } from '../../../ui/__tests__/render';
import type { AgentSpecV2 } from '@linuxdevil/lousho/spec';

const mocks = vi.hoisted(() => ({ listTraces: vi.fn(), channelTriggerStatus: vi.fn() }));

vi.mock('../../../runtime/runtimeClient', () => ({
  runtimeClient: { listTraces: mocks.listTraces, channelTriggerStatus: mocks.channelTriggerStatus },
}));

import { AgentDetailContext } from '../AgentDetailContext';
import { AgentOverviewTab } from '../AgentOverviewTab';

function meta(): AgentRecord['meta'] {
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
  };
}

function record(over: { spec?: Partial<AgentSpecV2>; requirements?: Requirement[] } = {}): AgentRecord {
  return {
    id: 'support-bot',
    spec: {
      version: 2,
      name: 'Support bot',
      model: 'anthropic/claude-sonnet-5-5',
      instructions: 'Be helpful.',
      ...over.spec,
    } as AgentSpecV2,
    meta: meta(),
    layout: { schemaVersion: 1, nodes: {}, notes: [] },
    updatedAt: '2026-10-29T10:00:00Z',
    latestVersion: null,
    publishState: { version: null, matchesWorkingCopy: false, publishedAt: null },
    requirements: over.requirements,
  };
}

function trace(id: string, over: Partial<TraceSummaryPayload> = {}): TraceSummaryPayload {
  return {
    traceId: id,
    name: `Run ${id}`,
    agent: 'support-bot',
    startTime: Date.now() - 180_000,
    durationMs: 1200,
    status: 'ok',
    modelCalls: 1,
    toolCalls: 0,
    inputTokens: 10,
    outputTokens: 5,
    ...over,
  };
}

/** Mounts the tab inside the detail context the route provides. */
function renderTab(agent: AgentRecord = record()) {
  return render(
    <AgentDetailContext.Provider value={{ record: agent, refresh: () => {}, setRecord: () => {} }}>
      <AgentOverviewTab />
    </AgentDetailContext.Provider>,
  );
}

/** Flushes the listTraces promise and applies the state updates inside act. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The card `<section>` whose title reads `title`. */
function card(host: HTMLElement, title: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>('.card')].find(
    (el) => el.querySelector('.card-title')?.textContent === title,
  );
  if (found === undefined) throw new Error(`no card titled '${title}'`);
  return found;
}

/** The `dd` text of the overview row labelled `label` inside `cardEl`. */
function rowText(cardEl: HTMLElement, label: string): string {
  const row = [...cardEl.querySelectorAll('.agent-overview-row')].find(
    (el) => el.querySelector('dt')?.textContent === label,
  );
  if (row === undefined) throw new Error(`no row labelled '${label}'`);
  return row.querySelector('dd')?.textContent ?? '';
}

beforeEach(() => {
  mocks.listTraces.mockReset();
  mocks.listTraces.mockResolvedValue([]);
  mocks.channelTriggerStatus.mockReset();
  mocks.channelTriggerStatus.mockResolvedValue([]);
});

describe('AgentOverviewTab', () => {
  it('shows the missing-requirements banner with a Settings link', async () => {
    const requirements: Requirement[] = [
      { id: 'provider:anthropic', kind: 'provider_key', status: 'missing', label: 'Anthropic API key' },
      { id: 'model:x', kind: 'model', status: 'ok', label: 'Model x' },
    ];
    const host = renderTab(record({ requirements }));
    await flush();

    const banner = host.querySelector('.agent-overview-banner')!;
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.textContent).toContain('This agent can’t run yet: Anthropic API key.');
    const link = banner.querySelector<HTMLAnchorElement>('a.btn')!;
    expect(link.textContent).toBe('Open settings');
    expect(link.getAttribute('href')).toBe('#/settings');
  });

  it('hides the banner when nothing is missing or requirements are absent', async () => {
    const ok = renderTab(
      record({ requirements: [{ id: 'm', kind: 'model', status: 'ok', label: 'Model' }] }),
    );
    await flush();
    expect(ok.querySelector('.agent-overview-banner')).toBeNull();

    const absent = renderTab(record());
    await flush();
    expect(absent.querySelector('.agent-overview-banner')).toBeNull();
  });

  it('shows the six capability rows, with None for empty sections', async () => {
    const host = renderTab(
      record({ spec: { skills: [{ dir: 'skills/tone' }], tools: [{ builtin: 'http' }] } }),
    );
    await flush();

    const capabilities = card(host, 'Capabilities');
    expect(capabilities.querySelectorAll('.agent-overview-row').length).toBe(6);
    expect(rowText(capabilities, 'Skills')).toContain('tone');
    expect(rowText(capabilities, 'Tools')).toContain('http');
    expect(rowText(capabilities, 'Memory')).toContain('None');
    const memoryRow = [...capabilities.querySelectorAll('.agent-overview-row')].find(
      (el) => el.querySelector('dt')?.textContent === 'Memory',
    )!;
    expect(memoryRow.querySelector('.value-missing')?.textContent).toBe('None');
  });

  it('lists one line per trigger and the empty copy when there are none', async () => {
    const triggers: AgentSpecV2['triggers'] = [
      { id: 't1', type: 'chat' },
      { id: 't2', type: 'cron', cron: '0 9 * * 1-5', timezone: 'UTC', prompt: 'x' },
      { id: 't3', type: 'webhook', path: '/gh', promptTemplate: 'x' },
      { id: 't4', type: 'channel', channel: 'github', secrets: {} },
      { id: 't5', type: 'agent', after: 'triage', on: 'done', promptTemplate: 'x' },
    ];
    const host = renderTab(record({ spec: { triggers } }));
    await flush();

    const triggersCard = card(host, 'Triggers');
    const items = triggersCard.querySelectorAll('.agent-overview-list li');
    expect(items.length).toBe(5);
    expect(items[1].textContent).toContain('Cron · 0 9 * * 1-5 · UTC');
    // Webhook triggers show their public URL with a Copy button (R08a).
    expect(items[2].querySelector('.agent-overview-webhook code')?.textContent).toBe(
      `${window.location.origin}/hooks/support-bot/gh`,
    );
    expect(items[2].querySelector('.agent-overview-webhook button')?.textContent).toBe('Copy');

    const emptyHost = renderTab(record({ spec: { triggers: [] } }));
    await flush();
    expect(card(emptyHost, 'Triggers').textContent).toContain(
      'No triggers. Runs start from the Test pane or chat.',
    );
  });

  it('shows a channel trigger URL, its mount error, and the Runs/Traces note (R08b)', async () => {
    mocks.channelTriggerStatus.mockResolvedValue([
      {
        triggerId: 't4',
        channel: 'github',
        url: '/hooks/support-bot/channel/github',
        error: 'Channel github needs token',
      },
    ]);
    const triggers: AgentSpecV2['triggers'] = [
      { id: 't4', type: 'channel', channel: 'github', secrets: {} },
    ];
    const host = renderTab(record({ spec: { triggers } }));
    await flush();
    await flush();

    expect(mocks.channelTriggerStatus).toHaveBeenCalledWith('support-bot');
    const triggersCard = card(host, 'Triggers');
    const item = triggersCard.querySelector('.agent-overview-list li')!;
    expect(item.querySelector('.agent-overview-webhook code')?.textContent).toBe(
      `${window.location.origin}/hooks/support-bot/channel/github`,
    );
    expect(item.querySelector('.agent-overview-channel-error')?.textContent).toBe(
      'Channel github needs token',
    );
    expect(triggersCard.textContent).toContain('Channel runs show up in Runs and Traces.');
  });

  it('shows permission-rule counts by action in the Safety card', async () => {
    const host = renderTab(
      record({
        spec: {
          permissions: [
            { id: 'p1', tool: 'github_*', action: 'ask' },
            { id: 'p2', tool: '*', action: 'ask' },
            { id: 'p3', tool: 'rm', action: 'deny' },
          ],
        },
      }),
    );
    await flush();
    expect(rowText(card(host, 'Safety'), 'Permission rules')).toBe('1 deny · 2 ask');
  });

  it('shows a skeleton status while runs load', async () => {
    mocks.listTraces.mockReturnValue(new Promise(() => {}));
    const host = renderTab();
    await flush();
    expect(card(host, 'Recent runs').querySelector('[role="status"]')?.textContent).toBe('Loading');
  });

  it('links each recent run to its trace', async () => {
    mocks.listTraces.mockResolvedValue([trace('t-1'), trace('t-2', { status: 'error' })]);
    const host = renderTab();
    await flush();

    const runsCard = card(host, 'Recent runs');
    const links = runsCard.querySelectorAll<HTMLAnchorElement>('a.agent-overview-run');
    expect(links.length).toBe(2);
    expect(links[0].getAttribute('href')).toBe('#/traces/t-1');
    expect(links[1].getAttribute('href')).toBe('#/traces/t-2');
    expect(links[0].querySelector('.agent-overview-run-name')?.textContent).toBe('Run t-1');
  });

  it('shows the empty copy and a Test pane link when there are no runs', async () => {
    const host = renderTab();
    await flush();

    const runsCard = card(host, 'Recent runs');
    expect(runsCard.textContent).toContain('No runs yet. Try it from the Test pane.');
    const link = [...runsCard.querySelectorAll<HTMLAnchorElement>('a.btn')].find(
      (a) => a.textContent === 'Open Test pane',
    )!;
    expect(link.getAttribute('href')).toBe('#/agents/support-bot/canvas?test=1');
  });

  it('shows a retryable error when the run list fails', async () => {
    mocks.listTraces.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([trace('t-9')]);
    const host = renderTab();
    await flush();

    const runsCard = card(host, 'Recent runs');
    expect(runsCard.textContent).toContain('Could not load runs.');
    const retry = [...runsCard.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    act(() => retry.click());
    await flush();

    expect(mocks.listTraces).toHaveBeenCalledTimes(2);
    expect(runsCard.querySelectorAll('a.agent-overview-run').length).toBe(1);
  });

  it('links All runs to the runs tab now that it is built', async () => {
    const host = renderTab();
    await flush();
    const runsCard = card(host, 'Recent runs');
    const link = [...runsCard.querySelectorAll<HTMLAnchorElement>('a')].find((a) => a.textContent === 'All runs');
    expect(link?.getAttribute('href')).toBe('#/agents/support-bot/runs');
  });
});
