import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  inboxCount: vi.fn(),
  subscribeEvents: vi.fn(() => () => {}),
}));
vi.mock('../../runtime/runtimeClient', () => ({ runtimeClient: api }));

import { NavRail } from '../NavRail';
import { render } from '../../ui/__tests__/render';

const inboxLink = (container: HTMLElement) =>
  [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '#/inbox') as HTMLAnchorElement;

beforeEach(() => {
  api.inboxCount.mockReset().mockResolvedValue({ count: 0 });
  api.subscribeEvents.mockClear();
  window.location.hash = '#/inbox';
});

describe('NavRail inbox badge', () => {
  it('shows no badge at zero and the count when items wait', async () => {
    api.inboxCount.mockResolvedValue({ count: 0 });
    const empty = render(<NavRail />);
    await act(async () => {});
    expect(empty.querySelector('.nav-badge')).toBeNull();

    api.inboxCount.mockResolvedValue({ count: 7 });
    const full = render(<NavRail />);
    await act(async () => {});
    const badge = full.querySelector('.nav-badge');
    expect(badge?.textContent).toBe('7');
    expect(badge?.getAttribute('aria-label')).toBe('7 waiting');
  });

  it('caps the badge at 99+', async () => {
    api.inboxCount.mockResolvedValue({ count: 120 });
    const container = render(<NavRail />);
    await act(async () => {});
    expect(container.querySelector('.nav-badge')?.textContent).toBe('99+');
  });

  it('shows only a dot on the collapsed rail', async () => {
    api.inboxCount.mockResolvedValue({ count: 3 });
    const container = render(<NavRail collapsed />);
    await act(async () => {});
    const link = inboxLink(container);
    expect(link.querySelector('.nav-badge')).toBeNull();
    expect(link.querySelector('.nav-badge-dot')).not.toBeNull();
    expect(link.getAttribute('aria-label')).toBe('Inbox (3 waiting)');
  });
});
