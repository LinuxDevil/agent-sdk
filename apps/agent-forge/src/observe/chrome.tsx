/** Shared bits of the observe panels' chrome: the daemon-down empty state, inline API errors, status pills, filter controls. */

import { useEffect, useState } from 'react';
import { observeClient } from './observeClient';
import type { ObserveAgentRow } from './types';

const DEFAULT_OBSERVE_URL = 'http://127.0.0.1:7777';

/** The "All agents" filter select the panels share. */
export function AgentSelect({
  agents,
  value,
  onChange,
}: {
  agents: ObserveAgentRow[] | undefined;
  value: string;
  onChange: (agentId: string) => void;
}) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All agents</option>
      {(agents ?? []).map((agent) => (
        <option key={agent.agent_id} value={agent.agent_id}>
          {agent.name ?? agent.agent_id.slice(0, 8)}
        </option>
      ))}
    </select>
  );
}

/**
 * The "daemon not running" state every panel shares: the hint is the
 * command, not a dead error, and the health probe keeps polling so the
 * panels swap in by themselves once `lousho observe start` runs.
 */
export function ObserveDaemonDown() {
  const [target, setTarget] = useState<string | undefined>();
  useEffect(() => {
    let live = true;
    void observeClient.target().then((url) => {
      if (live) setTarget(url);
    });
    return () => {
      live = false;
    };
  }, []);
  // `=1` only reaches the default daemon; any other target must be spelled out.
  const value = target === undefined || target.replace(/\/+$/, '') === DEFAULT_OBSERVE_URL ? '1' : target;
  return (
    <div className="observe-empty" role="status">
      <p className="observe-empty-title">No data yet - the observe daemon is not reachable.</p>
      <p>
        Run <code>lousho observe start</code>, then set <code>LOUSHO_OBSERVE={value}</code> on your agents; their traces,
        scores and heartbeats show up here automatically.
      </p>
    </div>
  );
}

/** An API failure that is not "daemon down" (a 400/404/500 answer) - shown inline so the panel chrome stays put. */
export function ObserveError({ error }: { error: Error | undefined }) {
  if (!error) return null;
  return (
    <div className="observe-error" role="alert">
      {error.message}
    </div>
  );
}
