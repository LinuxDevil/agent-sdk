import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type CountFrame = { type: string; workspaceId?: string; count?: number };

const api = vi.hoisted(() => ({
  allInboxCount: vi.fn(),
  subscribeAllEvents: vi.fn<[(frame: CountFrame) => void], () => void>(() => () => {}),
}));
vi.mock('../../runtime/runtimeClient', () => ({ runtimeClient: api }));

// The rail's WorkspaceSwitcher reads the workspace context; these tests
// only exercise the nav items, so the list stays unloaded.
vi.mock('../../workspace/WorkspacesProvider', () => ({
  useWorkspaces: () => ({ list: undefined, launchId: undefined, activeId: undefined, error: undefined, refresh: async () => {} }),
  useWorkspacesMaybe: () => undefined,
}));

import { NavRail } from '../NavRail';
import { render } from '../../ui/__tests__/render';

const inboxLink = (container: HTMLElement) =>
  [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '#/inbox') as HTMLAnchorElement;

beforeEach(() => {
  api.allInboxCount.mockReset().mockResolvedValue(0);
  api.subscribeAllEvents.mockClear().mockImplementation(() => () => {});
  window.location.hash = '#/inbox';
});

describe('NavRail inbox badge', () => {
  it('shows no badge at zero and the Studio-wide count when items wait (W09b)', async () => {
    api.allInboxCount.mockResolvedValue(0);
    const empty = render(<NavRail />);
    await act(async () => {});
    expect(empty.querySelector('.nav-badge')).toBeNull();
    expect(api.allInboxCount).toHaveBeenCalled();

    api.allInboxCount.mockResolvedValue(7);
    const full = render(<NavRail />);
    await act(async () => {});
    const badge = full.querySelector('.nav-badge');
    expect(badge?.textContent).toBe('7');
    expect(badge?.getAttribute('aria-label')).toBe('7 waiting');
  });

  it('caps the badge at 99+', async () => {
    api.allInboxCount.mockResolvedValue(120);
    const container = render(<NavRail />);
    await act(async () => {});
    expect(container.querySelector('.nav-badge')?.textContent).toBe('99+');
  });

  it('updates from the aggregate inbox.count frame only (W09b)', async () => {
    api.allInboxCount.mockResolvedValue(2);
    const container = render(<NavRail />);
    await act(async () => {});
    expect(container.querySelector('.nav-badge')?.textContent).toBe('2');

    const onFrame = api.subscribeAllEvents.mock.calls[0][0] as (frame: { type: string; workspaceId?: string; count?: number }) => void;
    // A per-workspace count frame (real workspaceId) is not the badge's source.
    await act(async () => onFrame({ type: 'inbox.count', workspaceId: 'ws-a1b2c3', count: 99 }));
    expect(container.querySelector('.nav-badge')?.textContent).toBe('2');
    // The Studio-wide 'all' frame replaces it.
    await act(async () => onFrame({ type: 'inbox.count', workspaceId: 'all', count: 5 }));
    expect(container.querySelector('.nav-badge')?.textContent).toBe('5');
  });

  it('shows only a dot on the collapsed rail', async () => {
    api.allInboxCount.mockResolvedValue(3);
    const container = render(<NavRail collapsed />);
    await act(async () => {});
    const link = inboxLink(container);
    expect(link.querySelector('.nav-badge')).toBeNull();
    expect(link.querySelector('.nav-badge-dot')).not.toBeNull();
    expect(link.getAttribute('aria-label')).toBe('Inbox (3 waiting)');
  });

  it('marks Inbox active on a workspace-scoped inbox route (W09b)', async () => {
    api.allInboxCount.mockResolvedValue(0);
    window.location.hash = '#/w/app-1a2b3c/inbox';
    const container = render(<NavRail />);
    await act(async () => {});
    const link = inboxLink(container);
    expect(link.className).toContain('active');
    expect(link.getAttribute('aria-current')).toBe('page');
  });
});
