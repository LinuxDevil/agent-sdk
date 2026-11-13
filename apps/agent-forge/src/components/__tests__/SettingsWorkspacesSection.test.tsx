import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceListItem } from '../../../shared/wireTypes';
import { render } from '../../ui/__tests__/render';
import { ToastProvider } from '../../ui/Toast';

const api = vi.hoisted(() => ({
  scanWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  addWorkspace: vi.fn(),
}));
vi.mock('../../runtime/runtimeClient', () => ({ runtimeClient: api }));

const wsState = vi.hoisted(() => ({
  list: undefined as WorkspaceListItem[] | undefined,
  launchId: undefined as string | undefined,
  activeId: undefined as string | undefined,
  error: undefined as string | undefined,
  refresh: vi.fn(),
}));
vi.mock('../../workspace/WorkspacesProvider', () => ({
  useWorkspacesMaybe: () => wsState,
}));

import { WorkspacesSection } from '../SettingsWorkspacesSection';

const ws = (over: Partial<WorkspaceListItem> = {}): WorkspaceListItem => ({
  id: 'alpha-1a2b3c',
  name: 'Alpha',
  root: '/code/alpha',
  addedAt: '',
  lastOpenedAt: '',
  isLaunch: false,
  available: true,
  agentCount: 3,
  ...over,
});

const LIST = [
  ws({ id: 'alpha-1a2b3c', name: 'Alpha', root: '/code/alpha', isLaunch: true, agentCount: 1 }),
  ws({ id: 'beta-2b3c4d', name: 'Beta', root: '/code/beta', agentCount: 4 }),
  ws({ id: 'gamma-3c4d5e', name: 'Gamma', root: '/gone/gamma', available: false, agentCount: 0 }),
];

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount() {
  window.history.replaceState(null, '', '/#/settings');
  const host = render(
    <ToastProvider>
      <WorkspacesSection />
    </ToastProvider>
  );
  await flush();
  return host;
}

const buttonNamed = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name);

const rowOf = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll('li.settings-workspace')].find((li) => li.querySelector('.settings-workspace-name')?.textContent === name)!;

const toastTexts = (host: HTMLElement) => [...host.querySelectorAll('.toast-message')].map((el) => el.textContent);

const SCAN = (n: number) => ({
  workspaceId: 'beta-2b3c4d',
  scannedAt: '',
  patterns: [],
  agents: Array.from({ length: n }, (_, i) => ({
    path: `agents/a${i}`,
    name: `a${i}`,
    configFile: 'agent.ts',
    configKind: 'code' as const,
  })),
});

beforeEach(() => {
  vi.clearAllMocks();
  wsState.list = LIST;
  wsState.launchId = 'alpha-1a2b3c';
  wsState.activeId = undefined;
  wsState.error = undefined;
  window.history.replaceState(null, '', '/#/settings');
});

describe('WorkspacesSection', () => {
  it('lists every workspace with name, folder, agent count and state pills', async () => {
    const host = await mount();
    const card = host.querySelector('section.settings-card[aria-label="Workspaces"]')!;
    expect(card.textContent).toContain('Project folders Studio shows agents from.');
    const alpha = rowOf(host, 'Alpha');
    expect(alpha.querySelector('.settings-workspace-root')?.textContent).toBe('/code/alpha');
    expect(alpha.textContent).toContain('1 agent');
    expect(alpha.textContent).toContain('Started here');
    const beta = rowOf(host, 'Beta');
    expect(beta.textContent).toContain('4 agents');
    const gamma = rowOf(host, 'Gamma');
    expect(gamma.textContent).toContain('0 agents');
    expect(gamma.textContent).toContain('Folder missing');
    expect(host.querySelector('.settings-actions .btn-primary')?.textContent).toBe('Add workspace');
  });

  it('launch workspace Remove is disabled with the reason as title; missing folder Rescan too', async () => {
    const host = await mount();
    const alphaRemove = [...rowOf(host, 'Alpha').querySelectorAll('button')].find((b) => b.textContent?.includes('Remove'))!;
    expect(alphaRemove.disabled).toBe(true);
    expect(alphaRemove.getAttribute('title')).toContain('Studio was started in this folder');
    const gammaRescan = [...rowOf(host, 'Gamma').querySelectorAll('button')].find((b) => b.textContent?.includes('Rescan'))!;
    expect(gammaRescan.disabled).toBe(true);
    expect(gammaRescan.getAttribute('title')).toBe('This folder is missing.');
    const betaRescan = [...rowOf(host, 'Beta').querySelectorAll('button')].find((b) => b.textContent?.includes('Rescan'))!;
    expect(betaRescan.disabled).toBe(false);
  });

  it('Rescan posts the scan and toasts the plural count', async () => {
    api.scanWorkspace.mockResolvedValue(SCAN(2));
    const host = await mount();
    const rescan = [...rowOf(host, 'Beta').querySelectorAll('button')].find((b) => b.textContent?.includes('Rescan'))!;
    await act(async () => rescan.click());
    await flush();
    expect(api.scanWorkspace).toHaveBeenCalledWith('beta-2b3c4d');
    expect(toastTexts(host)).toContain('Found 2 code agents in Beta.');
  });

  it('Rescan toasts the singular and shows "Scanning…" while pending', async () => {
    let resolve!: (v: unknown) => void;
    api.scanWorkspace.mockReturnValue(new Promise((r) => (resolve = r)));
    const host = await mount();
    const rescan = [...rowOf(host, 'Beta').querySelectorAll('button')].find((b) => b.textContent?.includes('Rescan'))!;
    await act(async () => rescan.click());
    await flush();
    expect(rescan.textContent).toContain('Scanning…');
    expect(rescan.disabled).toBe(true);
    await act(async () => resolve(SCAN(1)));
    await flush();
    expect(toastTexts(host)).toContain('Found 1 code agent in Beta.');
  });

  it('Rescan failure toasts the server message', async () => {
    api.scanWorkspace.mockRejectedValue(new Error('scan exploded'));
    const host = await mount();
    const rescan = [...rowOf(host, 'Beta').querySelectorAll('button')].find((b) => b.textContent?.includes('Rescan'))!;
    await act(async () => rescan.click());
    await flush();
    expect(toastTexts(host)).toContain('scan exploded');
  });

  it('Remove asks first, then removes, refreshes, toasts and navigates out of the removed workspace', async () => {
    api.removeWorkspace.mockResolvedValue(undefined);
    wsState.activeId = 'beta-2b3c4d';
    const host = await mount();
    window.history.replaceState(null, '', '/#/w/beta-2b3c4d/agents');
    const remove = [...rowOf(host, 'Beta').querySelectorAll('button')].find((b) => b.textContent?.includes('Remove'))!;
    await act(async () => remove.click());
    await flush();
    // The confirm dialog is open with the danger copy; nothing removed yet.
    const dialog = document.body.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Remove “Beta” from Studio?');
    expect(dialog.textContent).toContain('Nothing in the folder is deleted');
    expect(api.removeWorkspace).not.toHaveBeenCalled();
    const confirm = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Remove workspace')!;
    await act(async () => confirm.click());
    await flush();
    expect(api.removeWorkspace).toHaveBeenCalledWith('beta-2b3c4d');
    expect(wsState.refresh).toHaveBeenCalled();
    expect(toastTexts(host)).toContain('Removed “Beta”.');
    expect(window.location.hash).toBe('#/agents');
  });

  it('Remove failure keeps the dialog open with the server error', async () => {
    api.removeWorkspace.mockRejectedValue(new Error('registry locked'));
    const host = await mount();
    const remove = [...rowOf(host, 'Beta').querySelectorAll('button')].find((b) => b.textContent?.includes('Remove'))!;
    await act(async () => remove.click());
    await flush();
    const dialog = document.body.querySelector('[role="alertdialog"]')!;
    const confirm = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Remove workspace')!;
    await act(async () => confirm.click());
    await flush();
    expect(dialog.textContent).toContain('registry locked');
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(toastTexts(host)).not.toContain('Removed “Beta”.');
  });

  it('shows three skeleton rows while the list loads and the retry row on error', async () => {
    wsState.list = undefined;
    let host = await mount();
    expect(host.querySelectorAll('.settings-workspace-skeleton')).toHaveLength(3);
    wsState.error = 'GET /workspaces failed';
    wsState.list = LIST;
    host = await mount();
    expect(host.textContent).toContain('GET /workspaces failed');
    const retry = buttonNamed(host, 'Retry')!;
    expect(retry).toBeDefined();
    await act(async () => retry.click());
    expect(wsState.refresh).toHaveBeenCalled();
  });
});
