import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord } from '../../../../shared/wireTypes';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';

const mocks = vi.hoisted(() => ({
  createAgentRecord: vi.fn(),
  deleteAgent: vi.fn(),
  downloadExport: vi.fn(),
}));

vi.mock('../../../runtime/runtimeClient', () => ({
  runtimeClient: {
    createAgentRecord: mocks.createAgentRecord,
    deleteAgent: mocks.deleteAgent,
    downloadExport: mocks.downloadExport,
  },
}));

const appState = vi.hoisted(() => ({
  agentId: 'other-agent',
  agents: [{ id: 'other-agent' }],
  switchAgent: vi.fn<[string], Promise<void>>(() => Promise.resolve()),
}));
vi.mock('../../../state/AppState', () => ({ useAppState: () => appState }));

import { takePendingOpen } from '../../../author/authorEntry';
import { AgentActionsMenu } from '../AgentActionsMenu';

function record(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'support-bot',
    spec: {
      version: 2,
      name: 'Support bot',
      model: 'mock/mock-1',
      instructions: 'Be helpful.',
      ...over.spec,
    },
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
      ...over.meta,
    },
    layout: { schemaVersion: 1, nodes: {}, notes: [] },
    updatedAt: '2026-10-29T10:00:00Z',
    latestVersion: null,
    publishState: { version: null, matchesWorkingCopy: false, publishedAt: null },
    ...over,
  };
}

function renderMenu(over: Partial<AgentRecord> = {}) {
  return render(
    <ToastProvider>
      <AgentActionsMenu record={record(over)} />
    </ToastProvider>,
  );
}

/** The ⋯ trigger, then the portalled menu's item whose label matches. */
function openMenu() {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  act(() => trigger.click());
  return document.querySelector<HTMLElement>('[role="menu"]')!;
}

function menuItem(label: string): HTMLElement {
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
  return [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((el) => el.textContent?.includes(label))!;
}

/** Lets pending promises and state updates settle inside act. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function toastTexts(): string {
  return [...document.querySelectorAll('.toast-message')].map((el) => el.textContent ?? '').join(' | ');
}

beforeEach(() => {
  mocks.createAgentRecord.mockReset();
  mocks.deleteAgent.mockReset();
  mocks.downloadExport.mockReset();
  mocks.downloadExport.mockResolvedValue({ blob: new Blob(['spec']), filename: 'support-bot.yaml', warnings: [] });
  takePendingOpen(); // drain any queued Author open
  appState.agentId = 'other-agent';
  window.history.replaceState(null, '', '/#/agents/support-bot/overview');
});

describe('AgentActionsMenu', () => {
  it('lists Change with AI, Duplicate, Export YAML and Delete agent… with one separator and a danger delete', () => {
    renderMenu();
    const menu = openMenu();

    const labels = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')].map((el) => el.textContent ?? '');
    expect(labels[0]).toContain('Change with AI');
    expect(labels[1]).toContain('Duplicate');
    expect(labels[2]).toContain('Export YAML');
    expect(labels[3]).toContain('Export bundle');
    expect(labels[4]).toContain('Delete agent…');
    expect(menu.querySelectorAll('[role="separator"]').length).toBe(1);
    expect(menuItem('Delete agent…').classList.contains('menu-item-danger')).toBe(true);
  });

  it('Change with AI opens the Author focused on this agent (AA19)', async () => {
    renderMenu();
    openMenu();
    await act(async () => {
      menuItem('Change with AI').click();
    });
    expect(takePendingOpen()).toEqual({ source: 'agent-header', focus: { mode: 'edit', agentId: 'support-bot' } });
  });

  it('duplicates the agent, toasts and opens the copy’s overview', async () => {
    mocks.createAgentRecord.mockResolvedValue({ id: 'support-bot-copy', spec: { name: 'support-bot copy' } });
    renderMenu();
    openMenu();

    await act(async () => {
      menuItem('Duplicate').click();
      await Promise.resolve();
    });
    await flush();

    expect(mocks.createAgentRecord).toHaveBeenCalledWith({ from: { copyOf: 'support-bot' } });
    expect(toastTexts()).toContain('Duplicated as “support-bot copy”');
    expect(window.location.hash).toBe('#/agents/support-bot-copy/overview');
  });

  it('exports the spec as <id>.yaml via the export route and toasts the filename', async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;
    const downloads: string[] = [];
    URL.createObjectURL = () => 'blob:mock';
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    };
    try {
      renderMenu();
      openMenu();
      await act(async () => {
        menuItem('Export YAML').click();
      });
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      HTMLAnchorElement.prototype.click = originalClick;
    }

    expect(mocks.downloadExport).toHaveBeenCalledWith('support-bot', 'yaml');
    expect(downloads).toEqual(['support-bot.yaml']);
    expect(toastTexts()).toContain('Exported support-bot.yaml');
  });

  it('asks before deleting; confirm deletes, toasts and returns to #/agents', async () => {
    let resolveDelete!: () => void;
    mocks.deleteAgent.mockReturnValue(new Promise<void>((resolve) => (resolveDelete = resolve)));
    renderMenu();
    openMenu();

    await act(async () => {
      menuItem('Delete agent…').click();
    });

    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.querySelector('.dialog-title')?.textContent).toBe('Delete “Support bot”?');

    // Cancel closes without deleting.
    const cancel = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!;
    await act(async () => {
      cancel.click();
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(mocks.deleteAgent).not.toHaveBeenCalled();

    // Confirm: pending state, then success.
    openMenu();
    await act(async () => {
      menuItem('Delete agent…').click();
    });
    const confirmDialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    const confirm = [...confirmDialog.querySelectorAll('button')].find((b) => b.textContent === 'Delete agent')!;
    await act(async () => {
      confirm.click();
    });
    expect(mocks.deleteAgent).toHaveBeenCalledWith('support-bot');
    const pendingFooter = document.querySelector('[role="alertdialog"] .dialog-footer')!;
    expect(pendingFooter.textContent).toContain('Deleting…');
    expect([...pendingFooter.querySelectorAll('button')].every((b) => b.disabled)).toBe(true);

    await act(async () => {
      resolveDelete();
      await Promise.resolve();
    });
    await flush();

    expect(toastTexts()).toContain('Agent deleted');
    expect(window.location.hash).toBe('#/agents');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    // The deleted agent was not the open document's, so nothing switches.
    expect(appState.switchAgent).not.toHaveBeenCalled();
  });

  it('shows the failure inside the dialog and keeps it open', async () => {
    mocks.deleteAgent.mockRejectedValue(new Error('disk full'));
    renderMenu();
    openMenu();
    await act(async () => {
      menuItem('Delete agent…').click();
    });
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    const confirm = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Delete agent')!;
    await act(async () => {
      confirm.click();
      await Promise.resolve();
    });
    await flush();

    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.querySelector('.dialog-error')?.textContent).toBe('disk full');
    expect(window.location.hash).toBe('#/agents/support-bot/overview');
  });
});
