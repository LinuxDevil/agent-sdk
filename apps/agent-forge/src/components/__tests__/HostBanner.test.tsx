import { describe, expect, it, vi } from 'vitest';

import type { HostStatus } from '../../../shared/wireTypes';
import { render } from '../../ui/__tests__/render';
import { HostBanner } from '../HostBanner';

function status(over: Partial<HostStatus> = {}): HostStatus {
  return {
    workspaceId: 'ws-abc123',
    mode: 'in-process',
    state: 'ready',
    sdkVersion: '1.0.0',
    studioSdkVersion: '1.0.0',
    banner: null,
    ...over,
  };
}

const banner = (over: Partial<NonNullable<HostStatus['banner']>> = {}) => ({
  tone: 'info' as const,
  text: 'Runs use Studio\'s built-in SDK.',
  ...over,
});

describe('HostBanner', () => {
  it('renders nothing without a status or a healthy banner-less bridge', () => {
    expect(render(<HostBanner status={undefined} />).innerHTML).toBe('');
    expect(render(<HostBanner status={status({ mode: 'bridge' })} />).innerHTML).toBe('');
  });

  it('info tone uses role="status" and shows the server text', () => {
    const el = render(<HostBanner status={status({ banner: banner() })} />);
    const node = el.querySelector('.host-banner')!;
    expect(node.getAttribute('role')).toBe('status');
    expect(node.textContent).toContain("Runs use Studio's built-in SDK.");
    expect(node.querySelector('svg')).not.toBeNull();
  });

  it('warning and danger tones use role="alert"', () => {
    const warn = render(<HostBanner status={status({ banner: banner({ tone: 'warning', text: 'update the SDK' }) })} />);
    expect(warn.querySelector('.host-banner')!.getAttribute('role')).toBe('alert');
    const danger = render(
      <HostBanner status={status({ mode: 'bridge', banner: banner({ tone: 'danger', text: 'crashed', action: 'restart' }) })} />
    );
    expect(danger.querySelector('.host-banner')!.getAttribute('role')).toBe('alert');
  });

  it('a restart banner offers Restart, shows Restarting… while busy, and reports errors', () => {
    const onRestart = vi.fn();
    const el = render(
      <HostBanner
        status={status({ mode: 'bridge', state: 'failed', banner: banner({ tone: 'danger', text: 'keeps stopping', action: 'restart' }) })}
        onRestart={onRestart}
      />
    );
    const button = el.querySelector<HTMLButtonElement>('.host-banner-restart')!;
    expect(button.textContent).toBe('Restart');
    button.click();
    expect(onRestart).toHaveBeenCalledTimes(1);

    const busy = render(
      <HostBanner
        status={status({ mode: 'bridge', state: 'restarting', banner: banner({ tone: 'danger', text: 'keeps stopping', action: 'restart' }) })}
        restarting
        onRestart={onRestart}
      />
    );
    const busyButton = busy.querySelector<HTMLButtonElement>('.host-banner-restart')!;
    expect(busyButton.textContent).toBe('Restarting…');
    expect(busyButton.disabled).toBe(true);

    const failed = render(
      <HostBanner
        status={status({ mode: 'bridge', state: 'failed', banner: banner({ tone: 'danger', action: 'restart' }) })}
        restartError="spawn failed"
        onRestart={onRestart}
      />
    );
    expect(failed.querySelector('.host-banner-error')!.textContent).toBe('Could not restart: spawn failed');
  });

  it('shows the stderr tail in a Show output disclosure only when failed', () => {
    const el = render(
      <HostBanner
        status={status({
          mode: 'bridge',
          state: 'failed',
          banner: banner({ tone: 'danger', action: 'restart' }),
          recentStderr: ['line one', 'line two'],
        })}
      />
    );
    const details = el.querySelector('details.host-banner-output')!;
    expect(details.querySelector('summary')!.textContent).toBe('Show output');
    expect(details.querySelector('pre')!.textContent).toBe('line one\nline two');

    // stderr on a non-failed state is ignored.
    const ok = render(
      <HostBanner status={status({ mode: 'bridge', state: 'ready', banner: banner(), recentStderr: ['noise'] })} />
    );
    expect(ok.querySelector('.host-banner-output')).toBeNull();
  });

  it('shows the restarting note when a bridge is mid-restart with no banner', () => {
    const el = render(<HostBanner status={status({ mode: 'bridge', state: 'restarting' })} />);
    const node = el.querySelector('.host-banner')!;
    expect(node.getAttribute('role')).toBe('status');
    expect(node.textContent).toContain('Restarting');
  });
});
