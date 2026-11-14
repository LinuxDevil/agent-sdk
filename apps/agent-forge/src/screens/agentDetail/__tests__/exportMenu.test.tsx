import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord } from '../../../../shared/wireTypes';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';

const mocks = vi.hoisted(() => ({
  downloadExport: vi.fn(),
  checkPortability: vi.fn(),
}));

vi.mock('../../../runtime/runtimeClient', () => ({
  runtimeClient: {
    downloadExport: mocks.downloadExport,
    checkPortability: mocks.checkPortability,
  },
  RuntimeApiError: class RuntimeApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly code?: string
    ) {
      super(message);
    }
  },
}));

const appState = vi.hoisted(() => ({
  agentId: 'support-bot',
  agents: [{ id: 'support-bot' }],
  switchAgent: vi.fn<[string], Promise<void>>(() => Promise.resolve()),
}));
vi.mock('../../../state/AppState', () => ({ useAppState: () => appState }));

import { AgentActionsMenu } from '../AgentActionsMenu';

const record: AgentRecord = {
  id: 'support-bot',
  spec: { version: 2, name: 'Support bot', model: 'mock/mock-1', instructions: 'Be helpful.' },
  meta: {
    schemaVersion: 1,
    enabled: true,
    disabledAt: null,
    disabledReason: null,
    failureStreak: 0,
    labels: [],
    publishedVersion: null,
    createdAt: '2026-10-29T09:00:00Z',
    updatedAt: '2026-10-29T09:00:00Z',
  },
  layout: { schemaVersion: 1, nodes: {}, notes: [] },
  updatedAt: '2026-10-29T10:00:00Z',
  latestVersion: null,
  publishState: { version: null, matchesWorkingCopy: false, publishedAt: null },
};

function renderMenu(): void {
  render(
    <ToastProvider>
      <AgentActionsMenu record={record} />
    </ToastProvider>,
  );
}

function openMenu(): void {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  act(() => trigger.click());
}

function menuItem(label: string): HTMLElement {
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
  return [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((el) => el.textContent?.includes(label))!;
}

async function clickItem(label: string): Promise<void> {
  await act(async () => {
    menuItem(label).click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mocks.downloadExport.mockReset();
  mocks.checkPortability.mockReset();
});

describe('export menu item (L09b)', () => {
  it('offers a single "Export…" item - the old YAML/bundle items are gone', async () => {
    renderMenu();
    openMenu();
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    const labels = [...menu.querySelectorAll('[role^="menuitem"]')].map((el) => el.textContent);
    expect(labels.filter((l) => l?.includes('Export'))).toEqual(['Export…']);
    expect(labels.some((l) => l?.includes('Export YAML'))).toBe(false);
    expect(labels.some((l) => l?.includes('Export bundle'))).toBe(false);
  });

  it('opens the export sheet for this agent', async () => {
    renderMenu();
    openMenu();
    await clickItem('Export…');
    expect(document.querySelector('.sheet-title')?.textContent).toBe('Export Support bot');
    expect(document.querySelector('.sheet-description')?.textContent).toBe(
      'Download this agent to keep it, share it or import it into another workspace.'
    );
    expect(document.querySelector('.export-format legend')?.textContent).toBe('Format');
    expect(mocks.downloadExport).not.toHaveBeenCalled();
  });

  it('closes the sheet from Cancel without downloading', async () => {
    renderMenu();
    openMenu();
    await clickItem('Export…');
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('.sheet-footer button')].find((b) =>
      b.textContent?.includes('Cancel')
    )!;
    await act(async () => {
      cancel.click();
      await Promise.resolve();
    });
    expect(document.querySelector('.sheet')).toBeNull();
    expect(mocks.downloadExport).not.toHaveBeenCalled();
  });
});
