import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { render } from '../../ui/__tests__/render';
import { WorkspacesProvider, useWorkspaces, type WorkspacesState } from '../WorkspacesProvider';
import { runtimeClient } from '../../runtime/runtimeClient';
import type { WorkspaceList } from '../../../shared/wireTypes';

const LIST: WorkspaceList = {
  defaultId: 'launch-abc123',
  workspaces: [
    {
      id: 'launch-abc123',
      name: 'launch',
      root: '/tmp/launch',
      addedAt: '2026-01-01T00:00:00.000Z',
      lastOpenedAt: '2026-01-01T00:00:00.000Z',
      isLaunch: true,
      available: true,
      agentCount: 1,
      observeProject: 'default',
    },
    {
      id: 'proj-def456',
      name: 'proj',
      root: '/tmp/proj',
      addedAt: '2026-01-01T00:00:00.000Z',
      lastOpenedAt: '2026-01-01T00:00:00.000Z',
      isLaunch: false,
      available: true,
      agentCount: 0,
      observeProject: 'default',
    },
  ],
};

/** The latest `useWorkspaces()` value, captured by the probe child. */
let state: WorkspacesState | undefined;
function Probe() {
  state = useWorkspaces();
  return null;
}

function mount() {
  return render(
    <WorkspacesProvider>
      <Probe />
    </WorkspacesProvider>
  );
}

describe('WorkspacesProvider', () => {
  beforeEach(() => {
    state = undefined;
    window.location.hash = '';
    vi.restoreAllMocks();
  });

  it('loads the list once and exposes launchId/activeId', async () => {
    const spy = vi.spyOn(runtimeClient, 'listWorkspaces').mockResolvedValue(LIST);
    mount();
    await act(async () => {});
    expect(spy).toHaveBeenCalledTimes(1);
    expect(state?.list).toEqual(LIST.workspaces);
    expect(state?.launchId).toBe('launch-abc123');
    expect(state?.activeId).toBe('launch-abc123');
    expect(state?.error).toBeUndefined();
  });

  it('renders children while the list is still loading', async () => {
    let resolve!: (value: WorkspaceList) => void;
    vi.spyOn(runtimeClient, 'listWorkspaces').mockReturnValue(new Promise((r) => (resolve = r)));
    mount();
    await act(async () => {});
    expect(state?.list).toBeUndefined();
    expect(state?.launchId).toBeUndefined();
    await act(async () => resolve(LIST));
    expect(state?.list).toHaveLength(2);
  });

  it('activeId follows hashchange between workspaces', async () => {
    vi.spyOn(runtimeClient, 'listWorkspaces').mockResolvedValue(LIST);
    mount();
    await act(async () => {});
    expect(state?.activeId).toBe('launch-abc123');

    window.location.hash = '#/w/proj-def456/agents';
    await act(async () => {
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(state?.activeId).toBe('proj-def456');

    window.location.hash = '#/agents';
    await act(async () => {
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(state?.activeId).toBe('launch-abc123');
  });

  it('surfaces the load error and recovers on refresh', async () => {
    const spy = vi
      .spyOn(runtimeClient, 'listWorkspaces')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(LIST);
    mount();
    await act(async () => {});
    expect(state?.error).toBe('Error: boom');
    expect(state?.list).toBeUndefined();

    await act(async () => {
      await state?.refresh();
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(state?.error).toBeUndefined();
    expect(state?.list).toHaveLength(2);
  });
});
