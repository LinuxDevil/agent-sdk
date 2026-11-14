/**
 * The header menu's Duplicate item (L10): calls
 * `runtimeClient.duplicateAgent`, toasts `Made a copy: …` and lands on
 * the copy's canvas; a failure toasts `Couldn't duplicate: …` and stays.
 */
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord } from '../../../../shared/wireTypes';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';

const mocks = vi.hoisted(() => ({
  duplicateAgent: vi.fn(),
}));

vi.mock('../../../runtime/runtimeClient', () => ({
  runtimeClient: {
    duplicateAgent: mocks.duplicateAgent,
    createAgentRecord: vi.fn(),
    deleteAgent: vi.fn(),
    downloadExport: vi.fn(),
  },
}));

const appState = vi.hoisted(() => ({
  agentId: 'other-agent',
  agents: [{ id: 'other-agent' }],
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
  return [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((el) =>
    el.textContent?.includes(label)
  )!;
}

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
  mocks.duplicateAgent.mockReset();
  window.history.replaceState(null, '', '/#/agents/support-bot/overview');
});

describe('Duplicate menu item (L10)', () => {
  it('duplicates via duplicateAgent, toasts and opens the copy canvas', async () => {
    mocks.duplicateAgent.mockResolvedValue({
      id: 'support-bot-copy',
      spec: { name: 'Support bot copy' },
    });
    renderMenu();
    openMenu();
    await act(async () => {
      menuItem('Duplicate').click();
      await Promise.resolve();
    });
    await flush();

    expect(mocks.duplicateAgent).toHaveBeenCalledWith('support-bot');
    expect(toastTexts()).toContain('Made a copy: Support bot copy. It is off until you turn it on.');
    expect(window.location.hash).toBe('#/agents/support-bot-copy/canvas');
  });

  it('toasts the failure and stays on the agent', async () => {
    mocks.duplicateAgent.mockRejectedValue(new Error('No agent \'support-bot\' to copy'));
    renderMenu();
    openMenu();
    await act(async () => {
      menuItem('Duplicate').click();
      await Promise.resolve();
    });
    await flush();

    expect(toastTexts()).toContain("Couldn't duplicate: No agent 'support-bot' to copy");
    expect(window.location.hash).toBe('#/agents/support-bot/overview');
  });
});
