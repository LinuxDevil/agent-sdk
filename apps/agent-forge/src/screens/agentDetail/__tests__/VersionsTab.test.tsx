import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord, StudioEvent, VersionListItem } from '../../../../shared/wireTypes';
import type { AgentSpecV2 } from 'lousho/spec';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';

const mocks = vi.hoisted(() => ({
  listVersions: vi.fn(),
  saveVersion: vi.fn(),
  eventHandler: undefined as ((event: StudioEvent) => void) | undefined,
}));

vi.mock('../../../runtime/runtimeClient', () => ({
  runtimeClient: { listVersions: mocks.listVersions, saveVersion: mocks.saveVersion },
}));

vi.mock('../../../state/useStudioEvents', () => ({
  useStudioEvents: (handler: (event: StudioEvent) => void) => {
    mocks.eventHandler = handler;
  },
}));

import { AgentDetailContext } from '../AgentDetailContext';
import { VersionsTab } from '../VersionsTab';

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

function record(): AgentRecord {
  return {
    id: 'support-bot',
    spec: {
      version: 2,
      name: 'Support bot',
      model: 'anthropic/claude-sonnet-5-5',
      instructions: 'Be helpful.',
    } as AgentSpecV2,
    meta: meta(),
    layout: { schemaVersion: 1, nodes: {}, notes: [] },
    updatedAt: '2026-10-29T10:00:00Z',
    latestVersion: null,
    requirements: [],
  };
}

let versionCounter = 0;

function item(over: Partial<VersionListItem> = {}): VersionListItem {
  versionCounter += 1;
  return {
    version: versionCounter,
    kind: 'update',
    source: 'editor',
    changedFields: ['tools'],
    restoredFromVersion: null,
    summary: 'A saved change.',
    requestText: null,
    authorSessionId: null,
    specHash: 'abc',
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    ...over,
  };
}

/** Mounts the tab inside the detail context and toast provider the route provides. */
function renderTab() {
  return render(
    <ToastProvider>
      <AgentDetailContext.Provider value={{ record: record(), refresh: () => {}, setRecord: () => {} }}>
        <VersionsTab />
      </AgentDetailContext.Provider>
    </ToastProvider>,
  );
}

/** Flushes the fetch chain and applies the state updates inside act. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

/** Clicks the first button whose text contains `label` and flushes. */
async function clickAndFlush(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(label),
  )!;
  act(() => button.click());
  await flush();
}

beforeEach(() => {
  versionCounter = 0;
  mocks.listVersions.mockReset();
  mocks.saveVersion.mockReset();
  mocks.listVersions.mockResolvedValue([]);
  mocks.saveVersion.mockResolvedValue({ item: item({ version: 9 }), created: true });
  mocks.eventHandler = undefined;
});

describe('VersionsTab', () => {
  it('shows the loading skeleton while the first fetch is in flight', async () => {
    mocks.listVersions.mockReturnValue(new Promise(() => {}));
    const host = renderTab();
    await flush();

    expect(host.querySelector('.skeleton-rows')).not.toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Loading');
  });

  it('renders versions newest first with the Current pill on the first item', async () => {
    mocks.listVersions.mockResolvedValue([
      item({ version: 3, kind: 'update', source: 'author', summary: 'Newest.', requestText: 'Make it cite sources' }),
      item({ version: 2, kind: 'restore', restoredFromVersion: 1, source: 'restore', summary: 'Back to v1.' }),
      item({ version: 1, kind: 'create', source: 'template', summary: 'First.' }),
    ]);
    const host = renderTab();
    await flush();

    const rows = [...host.querySelectorAll<HTMLElement>('.version-item')];
    expect(rows.map((r) => r.dataset.version)).toEqual(['3', '2', '1']);
    expect(rows[0].dataset.current).toBe('true');
    expect(rows[0].querySelector('.status-pill')?.textContent).toContain('Current');
    expect(rows[0].querySelector('.version-number')?.textContent).toBe('v3');
    expect(rows[0].querySelector('.version-kind')?.textContent).toBe('Edited');
    expect(rows[0].querySelector('.version-source')?.textContent).toBe('via Author');
    expect(rows[1].querySelector('.version-kind')?.textContent).toBe('Restored from v1');
    expect(rows[2].querySelector('.version-kind')?.textContent).toBe('Created');
    // Request text renders inside curly quotes only when present.
    expect(rows[0].querySelector('.version-request')?.textContent).toBe('“Make it cite sources”');
    expect(rows[1].querySelector('.version-request')).toBeNull();
    // Summaries render.
    expect(rows[0].querySelector('.version-summary')?.textContent).toBe('Newest.');
  });

  it('shows a skeleton plus hidden text while a summary is pending, then swaps it on version.summary', async () => {
    mocks.listVersions.mockResolvedValue([
      item({ version: 2, summary: null, createdAt: new Date().toISOString() }),
      item({ version: 1, summary: 'Done.', createdAt: new Date(Date.now() - 3_600_000).toISOString() }),
    ]);
    const host = renderTab();
    await flush();

    const first = host.querySelector('.version-item')!;
    expect(first.querySelector('.version-summary-skeleton')).not.toBeNull();
    expect(first.querySelector('.visually-hidden')?.textContent).toBe('Writing a summary');

    act(() => {
      mocks.eventHandler?.({ type: 'version.summary', agentId: 'support-bot', version: 2, summary: 'Added a tool.' });
    });
    await flush();

    const updated = host.querySelector('.version-item')!;
    expect(updated.querySelector('.version-summary-skeleton')).toBeNull();
    expect(updated.querySelector('.version-summary')?.textContent).toBe('Added a tool.');
    // No refetch for a summary event.
    expect(mocks.listVersions).toHaveBeenCalledTimes(1);
  });

  it('ignores version.summary events for other agents', async () => {
    mocks.listVersions.mockResolvedValue([item({ version: 1, summary: null, createdAt: new Date().toISOString() })]);
    const host = renderTab();
    await flush();

    act(() => {
      mocks.eventHandler?.({ type: 'version.summary', agentId: 'other-agent', version: 1, summary: 'Wrong agent.' });
    });
    await flush();

    expect(host.querySelector('.version-summary-skeleton')).not.toBeNull();
  });

  it('refreshes on agent.changed with a version-writing reason', async () => {
    mocks.listVersions.mockResolvedValue([item({ version: 1 })]);
    const host = renderTab();
    await flush();
    expect(mocks.listVersions).toHaveBeenCalledTimes(1);

    act(() => {
      mocks.eventHandler?.({ type: 'agent.changed', agentId: 'support-bot', reason: 'version' });
    });
    await flush();
    expect(mocks.listVersions).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll('.version-item').length).toBe(1);
  });

  it('caps field chips at four plus a +N overflow chip', async () => {
    mocks.listVersions.mockResolvedValue([
      item({ version: 1, changedFields: ['tools', 'instructions', 'model', 'skills', 'memory', 'evals'] }),
    ]);
    const host = renderTab();
    await flush();

    const chips = [...host.querySelectorAll<HTMLLIElement>('.version-fields .chip')];
    expect(chips.map((c) => c.textContent)).toEqual(['Tools', 'Instructions', 'Model', 'Skills', '+2']);
    expect(host.querySelector('.version-fields')?.getAttribute('aria-label')).toBe('Changed fields');
  });

  it('shows the baseline hint in place of a summary', async () => {
    mocks.listVersions.mockResolvedValue([
      item({ version: 1, kind: 'baseline', source: 'external_file_edit', summary: null, changedFields: [] }),
    ]);
    const host = renderTab();
    await flush();

    const row = host.querySelector('.version-item')!;
    expect(row.querySelector('.version-kind')?.textContent).toBe('Baseline');
    expect(row.querySelector('.version-summary')?.textContent).toBe(
      'Recorded before the file was edited outside Studio.',
    );
    expect(row.querySelector('.version-fields')).toBeNull();
  });

  it('shows the empty state with a Save version action', async () => {
    const host = renderTab();
    await flush();

    expect(host.querySelector('.empty-state-title')?.textContent).toBe('No versions yet');
    expect(host.querySelector('.empty-state-hint')?.textContent).toBe('Save a version to start the history.');
    expect(host.querySelector('.empty-state-action button')?.textContent).toContain('Save version');
  });

  it('shows the error state with a Retry action', async () => {
    mocks.listVersions.mockRejectedValue(new Error('boom'));
    const host = renderTab();
    await flush();

    expect(host.querySelector('.empty-state-title')?.textContent).toBe("Couldn't load versions");
    expect(host.querySelector('.empty-state-hint')?.textContent).toBe('boom');
    expect(host.querySelector('.empty-state-action button')?.textContent).toContain('Retry');
  });

  it('Save version toasts "Saved v<n>" and refreshes', async () => {
    mocks.listVersions.mockResolvedValue([item({ version: 3 })]);
    mocks.saveVersion.mockResolvedValue({ item: item({ version: 4 }), created: true });
    const host = renderTab();
    await flush();

    await clickAndFlush(host, 'Save version');

    expect(mocks.saveVersion).toHaveBeenCalledWith('support-bot');
    expect(host.querySelector('.toast-message')?.textContent).toBe('Saved v4');
    expect(mocks.listVersions).toHaveBeenCalledTimes(2);
  });

  it('Save version toasts "Nothing changed since v<n>" on the server no-op', async () => {
    mocks.listVersions.mockResolvedValue([item({ version: 3 })]);
    mocks.saveVersion.mockResolvedValue({ item: item({ version: 3 }), created: false });
    const host = renderTab();
    await flush();

    await clickAndFlush(host, 'Save version');

    expect(host.querySelector('.toast-message')?.textContent).toBe('Nothing changed since v3');
  });

  it('Save version toasts the error message on failure', async () => {
    mocks.listVersions.mockResolvedValue([item({ version: 1 })]);
    mocks.saveVersion.mockRejectedValue(new Error('disk full'));
    const host = renderTab();
    await flush();

    await clickAndFlush(host, 'Save version');

    expect(host.querySelector('.toast-message')?.textContent).toBe('disk full');
  });
});
