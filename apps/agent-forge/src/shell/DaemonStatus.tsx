import { useEffect, useState } from 'react';
import { observeClient } from '../observe/observeClient';
import { useDaemonHealth } from '../observe/useObserve';

type CollectorState = 'up' | 'down' | 'checking';

const LABELS: Record<CollectorState, string> = {
  up: 'Collector running',
  down: 'Collector unreachable',
  checking: 'Checking collector…',
};

/**
 * The nav rail's collector card: whether the observe daemon behind the
 * `/observe` proxy answers, and where. "checking" only until the first
 * health probe settles; the probe keeps polling, so it flips by itself when
 * `lousho observe start` runs or the daemon dies. On the collapsed rail only
 * the dot shows; the text stays as accessible text and the card's tooltip.
 */
export function DaemonStatus() {
  const health = useDaemonHealth();
  const up = health.data !== undefined;
  const state: CollectorState = up ? 'up' : health.down ? 'down' : 'checking';
  const [target, setTarget] = useState<string | undefined>();

  // Re-read on every up-transition: the proxy target can change across a daemon restart.
  useEffect(() => {
    if (!up) return undefined;
    let live = true;
    void observeClient.target().then((url) => {
      if (live) setTarget(url);
    });
    return () => {
      live = false;
    };
  }, [up]);

  const label = LABELS[state];
  return (
    <div className="nav-daemon" role="status" data-state={state} title={target ? `${label} at ${target}` : label}>
      <span className="nav-daemon-dot" aria-hidden="true" />
      <span className="nav-daemon-text">
        <span className="nav-daemon-label">{label}</span>
        {target && (
          <span className="nav-daemon-url" title={target}>
            {target}
          </span>
        )}
      </span>
    </div>
  );
}
