import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceListItem } from '../../../shared/wireTypes';
import { render } from '../../ui/__tests__/render';
import { ToastProvider } from '../../ui/Toast';

const state = vi.hoisted(() => ({
  list: undefined as WorkspaceListItem[] | undefined,
  launchId: undefined as string | undefined,
  activeId: undefined as string | undefined,
  error: undefined as string | undefined,
  refresh: vi.fn(async () => {}),
}));
vi.mock('../../workspace/WorkspacesProvider', () => ({
  useWorkspaces: () => ({ list: state.list, launchId: state.launchId, activeId: state.activeId, error: state.error, refresh: state.refresh }),
  useWorkspacesMaybe: () => ({ list: state.list, launchId: state.launchId, activeId: state.activeId, error: state.error, refresh: state.refresh }),
}));

const client = vi.hoisted(() => ({ addWorkspace: vi.fn() }));
vi.mock('../../runtime/runtimeClient', () => ({
  runtimeClient: { addWorkspace: client.addWorkspace },
  RuntimeApiError: class extends Error {},
}));

import { WorkspaceSwitcher } from '../WorkspaceSwitcher';

const ws = (id: string, name: string, available = true): WorkspaceListItem => ({
  id,
  name,
  root: `/code/${name}`,
  addedAt: '2025-01-01T00:00:00Z',
  lastOpenedAt: '2025-01-01T00:00:00Z',
  isLaunch: id === 'app-1a2b3c',
  available,
  agentCount: 0,
  observeProject: 'default',
});

const trigger = () => document.body.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
const menu = () => document.body.querySelector<HTMLElement>('.menu-list');
const itemBy = (label: string) =>
  [...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((el) => el.textContent?.includes(label));

function mount(collapsed = false) {
  return render(
    <ToastProvider>
      <WorkspaceSwitcher collapsed={collapsed} />
    </ToastProvider>,
  );
}

function go(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

beforeEach(() => {
  state.list = [ws('app-1a2b3c', 'support-bot'), ws('proj-def456', 'billing'), ws('gone-000000', 'old-folder', false)];
  state.launchId = 'app-1a2b3c';
  state.activeId = undefined;
  state.error = undefined;
  state.refresh.mockClear();
  client.addWorkspace.mockReset();
  window.history.replaceState(null, '', '/');
});

describe('WorkspaceSwitcher', () => {
  it('reads "All workspaces" on unscoped routes and the workspace name on /w/ routes', () => {
    mount();
    expect(trigger()!.textContent).toContain('All workspaces');
    go('#/w/proj-def456/agents/x/canvas');
    expect(trigger()!.textContent).toContain('billing');
  });

  it('lists All workspaces, the Workspaces heading, each workspace, and Add workspace…', () => {
    mount();
    act(() => trigger()!.click());
    const el = menu()!;
    expect(el).not.toBeNull();
    expect(el.textContent).toContain('All workspaces');
    expect(el.textContent).toContain('Workspaces');
    expect(el.textContent).toContain('support-bot');
    expect(el.textContent).toContain('billing');
    expect(el.textContent).toContain('Add workspace…');
    // 'old-folder' is unavailable: visible but disabled with its reason.
    const gone = itemBy('old-folder')!;
    expect(gone.getAttribute('aria-disabled')).toBe('true');
    expect(gone.getAttribute('title')).toBe('This folder is missing. Check the path in Settings.');
  });

  it('marks the current workspace checked and selects another workspace by navigating', () => {
    mount();
    go('#/w/proj-def456/agents');
    act(() => trigger()!.click());
    const billing = itemBy('billing')!;
    expect(billing.getAttribute('aria-checked')).toBe('true');
    expect(itemBy('All workspaces')!.getAttribute('aria-checked')).toBe('false');
    act(() => itemBy('support-bot')!.click());
    expect(window.location.hash).toBe('#/w/app-1a2b3c/agents');
  });

  it('"All workspaces" navigates to #/agents', () => {
    mount();
    go('#/w/app-1a2b3c/agents');
    act(() => trigger()!.click());
    act(() => itemBy('All workspaces')!.click());
    expect(window.location.hash).toBe('#/agents');
  });

  it('shows a loading trigger while the list is in flight and an error trigger on failure', () => {
    state.list = undefined;
    mount();
    expect(trigger()!.textContent).toContain('Loading workspaces…');
    expect(trigger()!.disabled).toBe(true);

    state.list = undefined;
    state.error = 'boom';
    mount();
    expect(trigger()!.textContent).toContain('Workspaces unavailable');
    expect(trigger()!.disabled).toBe(true);
  });

  it('collapsed rail shows an icon-only trigger named for the menu and current workspace', () => {
    mount(true);
    const btn = trigger()!;
    expect(btn.getAttribute('aria-label')).toBe('Switch workspace: All workspaces');
    go('#/w/app-1a2b3c/agents');
    expect(btn.getAttribute('aria-label')).toBe('Switch workspace: support-bot');
    expect(btn.textContent).not.toContain('support-bot');
  });

  it('Add workspace… opens the dialog; a successful add refreshes, toasts and navigates', async () => {
    const item = ws('new-1a2b3c', 'fresh-project');
    client.addWorkspace.mockResolvedValue(item);
    mount();
    act(() => trigger()!.click());
    act(() => itemBy('Add workspace…')!.click());
    const input = document.body.querySelector<HTMLInputElement>('#add-workspace-form input')!;
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '/code/fresh-project');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.type === 'submit' && b.textContent === 'Add workspace',
    )!;
    await act(async () => submit.click());
    expect(client.addWorkspace).toHaveBeenCalledWith('/code/fresh-project');
    expect(state.refresh).toHaveBeenCalled();
    expect(window.location.hash).toBe('#/w/new-1a2b3c/agents');
  });
});
