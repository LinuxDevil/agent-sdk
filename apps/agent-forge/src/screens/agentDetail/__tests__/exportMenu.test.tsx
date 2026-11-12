import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord } from '../../../../shared/wireTypes';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';

const mocks = vi.hoisted(() => ({
  downloadExport: vi.fn(),
}));

vi.mock('../../../runtime/runtimeClient', () => ({
  runtimeClient: {
    downloadExport: mocks.downloadExport,
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

function toastTexts(): string {
  return [...document.querySelectorAll('.toast-message')].map((el) => el.textContent ?? '').join(' | ');
}

/** Records anchor downloads the way jsdom cannot. */
function captureDownloads(): { downloads: string[]; restore: () => void } {
  const downloads: string[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = () => 'blob:mock';
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  };
  return {
    downloads,
    restore: () => {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      HTMLAnchorElement.prototype.click = originalClick;
    },
  };
}

beforeEach(() => {
  mocks.downloadExport.mockReset();
  mocks.downloadExport.mockResolvedValue({ blob: new Blob(['{}']), filename: 'support-bot.lousho-agent.json', warnings: [] });
});

describe('export menu items (L07)', () => {
  it('"Export bundle" downloads via downloadExport(id, "bundle") under the bundle filename', async () => {
    const { downloads, restore } = captureDownloads();
    try {
      renderMenu();
      openMenu();
      await clickItem('Export bundle');
    } finally {
      restore();
    }
    expect(mocks.downloadExport).toHaveBeenCalledWith('support-bot', 'bundle');
    expect(downloads).toEqual(['support-bot.lousho-agent.json']);
    expect(toastTexts()).toContain('Exported support-bot.lousho-agent.json');
  });

  it('shows each bundle warning as a warning toast, one line each', async () => {
    mocks.downloadExport.mockResolvedValue({
      blob: new Blob(['{}']),
      filename: 'support-bot.lousho-agent.json',
      warnings: ['Prompt \'support@prod\' could not be read.', 'Dataset \'ds1\' could not be read.'],
    });
    const { restore } = captureDownloads();
    try {
      renderMenu();
      openMenu();
      await clickItem('Export bundle');
    } finally {
      restore();
    }
    expect(toastTexts()).toContain("Prompt 'support@prod' could not be read.");
    expect(toastTexts()).toContain("Dataset 'ds1' could not be read.");
    expect(toastTexts()).not.toContain('Exported support-bot.lousho-agent.json');
  });

  it('shows an error toast when the export fails', async () => {
    mocks.downloadExport.mockRejectedValue(new Error('disk full'));
    renderMenu();
    openMenu();
    await clickItem('Export YAML');
    expect(toastTexts()).toContain('Export failed: disk full');
  });
});
