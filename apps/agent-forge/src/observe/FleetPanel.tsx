import { useEffect, useState } from 'react';
import { useAgents, useInsights } from './useObserve';
import type { ObserveAgentRow, ObserveAgentInsights } from './types';
import { fmtAge, fmtInt, fmtPercent } from './format';
import { ObserveDaemonDown, ObserveError, ObserveStatusPill } from './chrome';
import { ObserveDaemonDownError } from './observeClient';

/** Fleet freshness poll - the Monitoring surface is the "is my fleet up" pane, so it self-refreshes. */
const POLL_MS = 15_000;

function usePoll(ms: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return tick;
}

function agentLabel(agent: ObserveAgentRow): string {
  return agent.name ?? agent.agent_id.slice(0, 8);
}

/**
 * `GET /api/v1/agents` + `GET /api/v1/insights?days=1` - the fleet registry
 * (name, project, derived status, last heartbeat) joined with today's run
 * and error figures. "View traces" drills into the Traces tab scoped to
 * that agent via ObserveView's shared filter state.
 */
export function FleetPanel({ onShowTraces }: { onShowTraces: (agentId: string) => void }) {
  const tick = usePoll(POLL_MS);
  const agents = useAgents(undefined, tick);
  const today = useInsights({ days: 1 }, tick);
  const todayByAgent = new Map<string, ObserveAgentInsights>((today.data?.agents ?? []).map((a) => [a.agent_id, a]));

  if (agents.error instanceof ObserveDaemonDownError) return <ObserveDaemonDown />;

  const rows = agents.data ?? [];
  return (
    <div className="observe-panel">
      <ObserveError error={agents.error ?? today.error} />
      {agents.loading && agents.data === undefined ? (
        <div className="observe-loading">Loading fleet...</div>
      ) : rows.length === 0 ? (
        <div className="observe-empty">
          <p>No agents are registered yet. An agent registers on its first emit when <code>LOUSHO_OBSERVE=1</code>.</p>
        </div>
      ) : (
        <div className="observe-table-wrap">
          <table className="observe-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Project</th>
                <th>Status</th>
                <th>Last heartbeat</th>
                <th className="observe-num">Runs today</th>
                <th className="observe-num">Error rate</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((agent) => {
                const stats = todayByAgent.get(agent.agent_id);
                return (
                  <tr key={agent.agent_id}>
                    <td className="observe-cell-name" title={agent.agent_id}>
                      {agentLabel(agent)}
                      {agent.version && <span className="observe-meta"> v{agent.version}</span>}
                    </td>
                    <td>{agent.project ?? '-'}</td>
                    <td>
                      <ObserveStatusPill status={agent.status} />
                    </td>
                    <td title={agent.hostname ? `${agent.hostname}${agent.pid ? ` pid ${agent.pid}` : ''}` : undefined}>
                      {fmtAge(agent.heartbeat_age_ms)}
                    </td>
                    <td className="observe-num">{stats ? fmtInt(stats.runs) : '-'}</td>
                    <td className="observe-num">{stats ? fmtPercent(stats.error_rate) : '-'}</td>
                    <td>
                      <button className="btn btn-ghost" onClick={() => onShowTraces(agent.agent_id)}>
                        Traces
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
