import { useEffect, useMemo, useState } from 'react';

import { AgentSelect, ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { ObserveDaemonDownError } from '../../observe/observeClient';
import { useAgents, useDaemonHealth, useInsights } from '../../observe/useObserve';
import { navigate } from '../../router/router';
import { useQueryState } from '../../router/useRoute';
import { EmptyState } from '../../ui/EmptyState';
import { agentLabel, FleetTable } from './FleetTable';
import { MonitoringCharts } from './MonitoringCharts';
import {
  bucketTracesPath,
  chartWindow,
  formatWindow,
  parseWindow,
  WINDOWS,
  type MonitoringWindow,
} from './monitoringSeries';
// The shared daemon-down / error presentation is styled there.
import '../../observe/observe.css';
import './monitoring.css';

/** Fleet + charts refresh: Monitoring is the "is my fleet up" screen, so it polls by itself. */
export const MONITORING_POLL_MS = 15_000;

/** A counter that bumps every `ms`. */
function usePoll(ms: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return tick;
}

const parseAgent = (s: string | null): string => s ?? '';
const formatAgent = (v: string): string | null => v || null;

function WindowPicker({ value, onChange }: { value: MonitoringWindow; onChange: (w: MonitoringWindow) => void }) {
  return (
    <div className="mon-windows" role="group" aria-label="Window">
      {WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          className={`btn btn-ghost mon-window${w === value ? ' active' : ''}`}
          aria-pressed={w === value}
          onClick={() => onChange(w)}
        >
          {w}
        </button>
      ))}
    </div>
  );
}

/** Fleet registry, last-24h per-agent figures and the window's rollup series, all refreshed every 15 s (and when the daemon comes back). */
function useMonitoringData(win: MonitoringWindow, agentId: string) {
  const tick = usePoll(MONITORING_POLL_MS);
  const health = useDaemonHealth();
  const refreshKey = `${tick}:${health.down}`;
  // Re-read the clock on each poll so the window slides with time.
  const now = useMemo(() => Date.now(), [tick]);
  const chart = chartWindow(win, now);
  const agents = useAgents(undefined, refreshKey);
  const fleetInsights = useInsights({ days: 1 }, refreshKey);
  const insights = useInsights(
    { since: chart.from, until: chart.to, agent_id: agentId || undefined, granularity: chart.granularity },
    refreshKey,
  );
  const errors = [agents.error, fleetInsights.error, insights.error];
  const down = health.down || errors.some((e) => e instanceof ObserveDaemonDownError);
  return { agents, fleetInsights, insights, chart, down, error: errors.find((e) => e !== undefined) };
}

/**
 * `#/monitoring?window=1h|24h|7d|30d&agent=<id>` - the fleet table over the
 * Runs / Latency / Error rate / Cost / Tokens charts. Window (default 24h, not
 * written) and agent live in the query string, so a reload keeps them.
 * Clicking a chart bucket opens Traces for that bucket (and agent). A dead
 * daemon shows the shared down state with the URL kept; the screen recovers
 * in place once the health probe sees it again.
 */
export function MonitoringScreen() {
  const [win, setWin] = useQueryState('window', parseWindow, formatWindow);
  const [agentId, setAgentId] = useQueryState('agent', parseAgent, formatAgent);
  const { agents, fleetInsights, insights, chart, down, error } = useMonitoringData(win, agentId);

  const names = useMemo(() => new Map((agents.data ?? []).map((a) => [a.agent_id, agentLabel(a)])), [agents.data]);
  const labelOf = (id: string) => names.get(id) ?? id.slice(0, 8);
  const rows = insights.data?.series ?? [];
  // An `agent=` id the fleet doesn't list still filters, so the select offers it too.
  const agentOptions = useMemo(() => {
    const fleet = agents.data ?? [];
    return agentId && !fleet.some((a) => a.agent_id === agentId) ? [...fleet, { agent_id: agentId, name: null }] : fleet;
  }, [agents.data, agentId]);

  if (down)
    return (
      <div className="mon-screen">
        <ObserveDaemonDown />
      </div>
    );
  return (
    <div className="mon-screen">
      <h2 className="visually-hidden">Monitoring</h2>
      <ObserveError error={error} />
      <section className="mon-fleet" aria-label="Fleet">
        <FleetTable
          agents={agents.data ?? []}
          insights={fleetInsights.data?.agents}
          loading={agents.loading && agents.data === undefined}
        />
      </section>
      <div className="mon-toolbar">
        <WindowPicker value={win} onChange={setWin} />
        <label className="mon-agent-filter">
          Agent
          <AgentSelect agents={agentOptions} value={agentId} onChange={setAgentId} />
        </label>
      </div>
      {insights.data === undefined && insights.loading ? (
        <div className="mon-loading">Loading charts...</div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No runs in this window"
          hint="Charts fill in as agents report runs; try a longer window or another agent."
        />
      ) : (
        <MonitoringCharts
          rows={rows}
          window={chart}
          agentLabel={labelOf}
          onBucketClick={(from, to) => navigate(bucketTracesPath(from, to, agentId))}
        />
      )}
    </div>
  );
}
