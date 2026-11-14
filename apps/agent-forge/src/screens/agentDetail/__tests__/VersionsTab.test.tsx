import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord, StudioEvent, VersionListItem } from '../../../../shared/wireTypes';
import type { AgentSpecV2 } from 'lousho/spec';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';

const mocks = vi.hoisted(() => ({
  listVersions: vi.fn(),
  saveVersion: vi.fn(),
  diffVersion: vi.fn(),
  getVersion: vi.fn(),
  restoreVersion: vi.fn(),
  publish: vi.fn(),
  eventHandler: undefined as ((event: StudioEvent) => void) | undefined,
}));

vi.mock('../../../runtime/runtimeClient', () => ({
  runtimeClient: {
    listVersions: mocks.listVersions,
    saveVersion: mocks.saveVersion,
    diffVersion: mocks.diffVersion,
    getVersion: mocks.getVersion,
    restoreVersion: mocks.restoreVersion,
    publish: mocks.publish,
  },
  RuntimeApiError: class RuntimeApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly code?: string,
      public readonly details?: unknown,
      public readonly body?: unknown,
    ) {
      super(message);
    }
  },
}));

const appState = vi.hoisted(() => ({
  dirty: false,
  reload: vi.fn<[options?: { discardLocal?: boolean }], Promise<boolean>>(() => Promise.resolve(true)),
}));
vi.mock('../../../state/AppState', () => ({ useAppState: () => appState }));

vi.mock('../../../state/useStudioEvents', () => ({
  useStudioEvents: (handler: (event: StudioEvent) => void) => {
    mocks.eventHandler = handler;
  },
}));

import { AgentDetailContext } from '../AgentDetailContext';
import { VersionsTab } from '../VersionsTab';
import { RuntimeApiError } from '../../../runtime/runtimeClient';

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
    publishState: {
      version: publishedPin,
      matchesWorkingCopy: publishedPin !== null,
      publishedAt: publishedPin === null ? null : '2026-10-29T11:00:00Z',
    },
    requirements: [],
  };
}

let versionCounter = 0;
/** The publish pointer the fixture record reports (L14b); `null` = nothing published. */
let publishedPin: number | null = null;

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
  publishedPin = null;
  mocks.listVersions.mockReset();
  mocks.saveVersion.mockReset();
  mocks.publish.mockReset();
  mocks.publish.mockResolvedValue({ publishedVersion: 3 });
  mocks.listVersions.mockResolvedValue([]);
  mocks.saveVersion.mockResolvedValue({ item: item({ version: 9 }), created: true });
  mocks.diffVersion.mockReset();
  mocks.getVersion.mockReset();
  mocks.diffVersion.mockResolvedValue([]);
  mocks.getVersion.mockResolvedValue(item({ version: 1 }));
  mocks.restoreVersion.mockReset();
  mocks.restoreVersion.mockResolvedValue(
    item({ version: 4, kind: 'restore', source: 'restore', restoredFromVersion: 2 }),
  );
  appState.dirty = false;
  appState.reload.mockClear();
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

  it('gives every item a Changes button except a baseline v1, opening one shared diff sheet', async () => {
    mocks.listVersions.mockResolvedValue([
      item({ version: 3 }),
      item({ version: 2, kind: 'baseline', source: 'external_file_edit', summary: null }),
      item({ version: 1, kind: 'baseline', source: 'external_file_edit', summary: null }),
    ]);
    const host = renderTab();
    await flush();

    const rows = [...host.querySelectorAll<HTMLElement>('.version-item')];
    const changesButton = (row: HTMLElement) =>
      [...row.querySelectorAll<HTMLButtonElement>('.version-actions button')].find((b) =>
        b.textContent?.includes('Changes'),
      );
    expect(changesButton(rows[0])).not.toBeNull();
    expect(changesButton(rows[1])).not.toBeNull();
    expect(changesButton(rows[2])).toBeUndefined();

    // Opening v3's sheet fetches its diff against v2; Escape closes it and
    // returns focus to the Changes button (U04 useModal behaviour).
    const button = changesButton(rows[0])!;
    button.focus();
    act(() => button.click());
    await flush();
    expect(document.querySelector('.sheet-title')?.textContent).toBe('v3 changes');
    expect(mocks.diffVersion).toHaveBeenCalledWith('support-bot', 3, 2);
    expect(document.querySelectorAll('.sheet').length).toBe(1);

    act(() => {
      document
        .querySelector('.sheet')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await flush();
    expect(document.querySelector('.sheet')).toBeNull();
    expect(document.activeElement).toBe(button);
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

  it('shows Restore on every item but the current one and restores through the dialog', async () => {
    mocks.listVersions.mockResolvedValue([
      item({ version: 3 }),
      item({ version: 2 }),
      item({ version: 1, kind: 'create', source: 'template' }),
    ]);
    const refresh = vi.fn();
    render(
      <ToastProvider>
        <AgentDetailContext.Provider value={{ record: record(), refresh, setRecord: () => {} }}>
          <VersionsTab />
        </AgentDetailContext.Provider>
      </ToastProvider>,
    );
    await flush();

    const rows = [...document.querySelectorAll<HTMLElement>('.version-item')];
    const restoreButton = (row: HTMLElement) =>
      [...row.querySelectorAll<HTMLButtonElement>('.version-actions button')].find((b) =>
        b.textContent?.includes('Restore'),
      );
    expect(restoreButton(rows[0])).toBeUndefined();
    expect(restoreButton(rows[1])).not.toBeUndefined();
    expect(restoreButton(rows[2])).not.toBeUndefined();

    // v2's dialog names v4 as the version about to be written.
    act(() => restoreButton(rows[1])!.click());
    await flush();
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.querySelector('.dialog-title')?.textContent).toBe('Restore v2?');
    expect(dialog.textContent).toContain(
      'This writes v4 with the configuration from v2. Everything up to v3 stays in the history.',
    );

    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Restore v2'),
    )!;
    await act(async () => {
      confirm.click();
      await Promise.resolve();
    });
    await flush();

    expect(mocks.restoreVersion).toHaveBeenCalledWith('support-bot', 2);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.querySelector('.toast-message')?.textContent).toBe('Restored v2 as v4');
    expect(appState.reload).toHaveBeenCalledWith({ discardLocal: true });
    expect(refresh).toHaveBeenCalled();
    // The timeline refetched for the new restore item.
    expect(mocks.listVersions).toHaveBeenCalledTimes(2);
  });

  it('Save version toasts the error message on failure', async () => {
    mocks.listVersions.mockResolvedValue([item({ version: 1 })]);
    mocks.saveVersion.mockRejectedValue(new Error('disk full'));
    const host = renderTab();
    await flush();

    await clickAndFlush(host, 'Save version');

    expect(host.querySelector('.toast-message')?.textContent).toBe('disk full');
  });

  it('marks the published version and offers "Publish this" on every other non-baseline item (L14b)', async () => {
    publishedPin = 2;
    mocks.listVersions.mockResolvedValue([
      item({ version: 3 }),
      item({ version: 2 }),
      item({ version: 1, kind: 'baseline', source: 'external_file_edit', summary: null }),
    ]);
    const host = renderTab();
    await flush();

    const rows = [...host.querySelectorAll<HTMLElement>('.version-item')];
    expect(rows[1].dataset.published).toBe('true');
    expect(rows[1].querySelector('.status-pill.pill-ok')?.textContent).toContain('Published');
    expect(rows[0].dataset.published).toBeUndefined();
    expect(rows[2].dataset.published).toBeUndefined();

    const publishButtons = rows.map((row) =>
      [...row.querySelectorAll<HTMLButtonElement>('.version-actions button')].find((b) =>
        b.textContent?.includes('Publish this'),
      ),
    );
    expect(publishButtons[0]).not.toBeUndefined();
    expect(publishButtons[1]).toBeUndefined();
    // Baselines are history markers, never publish candidates.
    expect(publishButtons[2]).toBeUndefined();
  });

  it('"Publish this" confirms in a dialog, pins the version, toasts and refreshes (L14b)', async () => {
    publishedPin = 1;
    mocks.listVersions.mockResolvedValue([item({ version: 3 }), item({ version: 2 }), item({ version: 1 })]);
    mocks.publish.mockResolvedValue({ publishedVersion: 3 });
    const refresh = vi.fn();
    render(
      <ToastProvider>
        <AgentDetailContext.Provider value={{ record: record(), refresh, setRecord: () => {} }}>
          <VersionsTab />
        </AgentDetailContext.Provider>
      </ToastProvider>,
    );
    await flush();

    const rows = [...document.querySelectorAll<HTMLElement>('.version-item')];
    const publishButton = [...rows[0].querySelectorAll<HTMLButtonElement>('.version-actions button')].find((b) =>
      b.textContent?.includes('Publish this'),
    )!;
    act(() => publishButton.click());
    await flush();

    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.querySelector('.dialog-title')?.textContent).toBe('Publish v3?');
    expect(dialog.textContent).toContain(
      'v3 becomes the live version. Serve, deploy and triggers use it. Your working copy does not change.',
    );

    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Publish v3'),
    )!;
    await act(async () => {
      confirm.click();
      await Promise.resolve();
    });
    await flush();

    expect(mocks.publish).toHaveBeenCalledWith('support-bot', { version: 3 });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.querySelector('.toast-message')?.textContent).toBe('Published v3');
    expect(refresh).toHaveBeenCalled();
    expect(mocks.listVersions).toHaveBeenCalledTimes(2);
  });

  it('"Publish this" swaps to the eval gate dialog on a 409 LOUSHO_EVAL_GATE_FAILED (X01b)', async () => {
    publishedPin = 1;
    mocks.listVersions.mockResolvedValue([item({ version: 3 }), item({ version: 2 }), item({ version: 1 })]);
    const evalResult = {
      passed: false,
      gates: [
        {
          dataset: 'ds',
          passRate: 0.5,
          minPassRate: 0.8,
          passed: false,
          examples: [{ exampleId: 'abcdef123456', passed: false, failures: ['Took 9 steps, limit 5'] }],
        },
      ],
      ranAt: '2026-01-02T03:04:05.000Z',
    };
    mocks.publish.mockRejectedValue(
      new RuntimeApiError('Eval gate failed', 409, 'LOUSHO_EVAL_GATE_FAILED', evalResult, {
        error: 'Eval gate failed',
        code: 'LOUSHO_EVAL_GATE_FAILED',
        version: 3,
        details: evalResult,
      }),
    );
    const refresh = vi.fn();
    render(
      <ToastProvider>
        <AgentDetailContext.Provider value={{ record: record(), refresh, setRecord: () => {} }}>
          <VersionsTab />
        </AgentDetailContext.Provider>
      </ToastProvider>,
    );
    await flush();

    const rows = [...document.querySelectorAll<HTMLElement>('.version-item')];
    const publishButton = [...rows[0].querySelectorAll<HTMLButtonElement>('.version-actions button')].find((b) =>
      b.textContent?.includes('Publish this'),
    )!;
    act(() => publishButton.click());
    await flush();

    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Publish v3'),
    )!;
    await act(async () => {
      confirm.click();
      await Promise.resolve();
    });
    await flush();

    // The confirm dialog closed; the eval gate dialog shows the full result.
    expect(document.querySelector('.dialog-title')?.textContent).toBe('Eval gate failed');
    expect(document.querySelector('.dialog-description')?.textContent).toBe(
      'v3 was not published. Fix the failures or change the gate, then publish again.',
    );
    expect(document.querySelector('.eval-gate-set-name')?.textContent).toBe('ds');
    expect(document.querySelector('.eval-gate-example-failures li')?.textContent).toBe('Took 9 steps, limit 5');
    expect(refresh).not.toHaveBeenCalled();
    expect(document.querySelector('.toast-message')).toBeNull();
  });
});
