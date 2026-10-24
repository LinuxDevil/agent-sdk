import { useEffect, useState } from 'react';
import { observeClient } from '../observe/observeClient';
import { useDaemonHealth } from '../observe/useObserve';

/**
 * The nav rail's collector line: whether the observe daemon behind the
 * `/observe` proxy answers, and where. "checking" only until the first
 * health probe settles; the probe keeps polling, so it flips by itself when
 * `lousho observe start` runs or the daemon dies.
 */
export function DaemonStatus() {
  const health = useDaemonHealth();
  const up = health.data !== undefined;
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

  let text = 'Collector: checking…';
  if (up) text = target === undefined ? 'Collector: running' : `Collector: running at ${target}`;
  else if (health.down) text = 'Collector: not reachable';
  return (
    <p className="nav-daemon" role="status" data-state={up ? 'up' : health.down ? 'down' : 'checking'}>
      {text}
    </p>
  );
}
