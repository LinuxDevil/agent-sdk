import { Info, OctagonAlert, TriangleAlert } from 'lucide-react';
import type { HostBanner as HostBannerData, HostStatus } from '../../shared/wireTypes';
import './hostBanner.css';

/** Props for {@link HostBanner}: the status plus the restart action's state (owned by `useHostStatus`). */
export interface HostBannerProps {
  status: HostStatus | undefined;
  /** `useHostStatus`'s in-flight restart flag - disables the Restart button. */
  restarting?: boolean;
  /** `useHostStatus`'s last restart failure message. */
  restartError?: string;
  /** `useHostStatus.restart` - only invoked when `status.banner.action === 'restart'`. */
  onRestart?: () => void;
}

const TONE_ICON = { info: Info, warning: TriangleAlert, danger: OctagonAlert } as const;

interface BannerView {
  tone: NonNullable<HostBannerData>['tone'];
  text: string;
  showRestart: boolean;
  stderr: string[] | undefined;
}

/** What to render for a status, or null when there is nothing to say. */
function bannerView(status: HostStatus): BannerView | null {
  const banner = status.banner;
  const restarting = banner === null && status.state === 'restarting';
  const stderr = status.state === 'failed' && status.recentStderr !== undefined && status.recentStderr.length > 0
    ? status.recentStderr
    : undefined;
  if (banner === null && !restarting && stderr === undefined) return null;
  return {
    tone: banner?.tone ?? 'info',
    text:
      banner?.text ??
      (restarting ? "Restarting this project's agent process…" : "This project's agent process failed. See its output below."),
    showRestart: banner?.action === 'restart',
    stderr,
  };
}

/**
 * W11c: the workspace host banner - which SDK runs this workspace's agents
 * and why not (PLAN §19.4). Renders nothing when there is nothing to say
 * (no banner, a healthy bridge). `role="status"` for info, `role="alert"`
 * for warning/danger; a crashed bridge offers Restart and its stderr tail.
 */
export function HostBanner({ status, restarting = false, restartError, onRestart }: HostBannerProps): JSX.Element | null {
  const view = status === undefined ? null : bannerView(status);
  if (view === null) return null;
  const Icon = TONE_ICON[view.tone];
  return (
    <div className={`host-banner host-banner-${view.tone}`} role={view.tone === 'info' ? 'status' : 'alert'}>
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="host-banner-icon" />
      <p className="host-banner-text">{view.text}</p>
      {view.showRestart && onRestart !== undefined && (
        <button type="button" className="btn btn-secondary btn-sm host-banner-restart" onClick={onRestart} disabled={restarting}>
          {restarting ? 'Restarting…' : 'Restart'}
        </button>
      )}
      {restartError !== undefined && (
        <p className="host-banner-error" role="alert">
          {`Could not restart: ${restartError}`}
        </p>
      )}
      {view.stderr !== undefined && (
        <details className="host-banner-output">
          <summary>Show output</summary>
          <pre>{view.stderr.join('\n')}</pre>
        </details>
      )}
    </div>
  );
}
