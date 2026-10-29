import { useEffect, useMemo, useState } from 'react';

import { AgentSelect, ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { useAgents, useDaemonDown, useDaemonHealth, useInsights, useTaggedInsights } from '../../observe/useObserve';
import { navigate } from '../../router/router';
import { useQueryState } from '../../router/useRoute';
import { ScreenHeader } from '../../shell/ScreenHeader';
import { Card } from '../../ui/Card';
import { agentLabel, FleetTable } from './FleetTable';
import { MetricRow } from './MetricRow';
import { MonitoringCharts, MonitoringChartsEmpty, MonitoringChartsLoading } from './MonitoringCharts';
import { splitWindow } from './monitoringMetrics';
import {
  bucketTracesPath,
  chartWindow,
  formatWindow,
  insightsSpan,
  parseWindow,
  WINDOWS,
  type MonitoringWindow,
} from './monitoringSeries';
// The shared daemon-down / error presentation is styled there.
import '../../observe/observe.css';
// The `.segmented` / `.seg-btn` control the window picker shares with TimeRangePicker.
import '../../ui/filterBar.css';
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
    <div className="segmented mon-windows" role="group" aria-label="Window">
      {WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          className="seg-btn"
          aria-pressed={w === value}
          onClick={() => onChange(w)}
        >
          {w}
        </button>
      ))}
    </div>
  );
}

/**
 * Fleet registry, last-24h per-agent figures and the window's rollup series
 * (reaching back one more window, for the metric deltas), all refreshed every
 * 15 s (and when the daemon comes back).
 */
function useMonitoringData(win: MonitoringWindow, agentId: string) {
  const tick = usePoll(MONITORING_POLL_MS);
  const health = useDaemonHealth();
  const refreshKey = `${tick}:${health.down}`;
  // Re-read the clock on each poll so the window slides with time.
  const now = useMemo(() => Date.now(), [tick]);
  const chart = chartWindow(win, now);
  const agents = useAgents(undefined, refreshKey);
  const fleetInsights = useInsights({ days: 1 }, refreshKey);
  // Tagged by window and agent: a switch shows the loading state, not the old rows on the new buckets.
  const insights = useTaggedInsights(
    `${win}:${agentId}`,
    { ...insightsSpan(chart), agent_id: agentId || undefined, granularity: chart.granularity },
    refreshKey,
  );
  const queries = [agents, fleetInsights, insights];
  const down = useDaemonDown(health.down, queries);
  return { agents, fleetInsights, insights, chart, down, error: queries.find((q) => q.error)?.error };
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
  // Charts draw the window only; the earlier rows are the metric cards' comparison.
  const windowRows = splitWindow(rows, chart).window;
  const chartsLoading = insights.data === undefined && insights.loading;
  // An `agent=` id the fleet doesn't list still filters, so the select offers it too.
  const agentOptions = useMemo(() => {
    const fleet = agents.data ?? [];
    return agentId && !fleet.some((a) => a.agent_id === agentId) ? [...fleet, { agent_id: agentId, name: null }] : fleet;
  }, [agents.data, agentId]);

  const header = (
    <ScreenHeader
      title="Monitoring"
      className="mon-header"
      description="Fleet health, throughput, latency and cost over time."
      actions={
        <div className="mon-controls">
          <WindowPicker value={win} onChange={setWin} />
          <label className="mon-agent-filter">
            <span className="visually-hidden">Agent</span>
            <AgentSelect agents={agentOptions} value={agentId} onChange={setAgentId} />
          </label>
        </div>
      }
    />
  );
  if (down)
    return (
      <div className="mon-screen">
        {header}
        <ObserveDaemonDown />
      </div>
    );
  return (
    <div className="mon-screen">
      {header}
      <ObserveError error={error} />
      <MetricRow rows={rows} chart={chart} win={win} loading={chartsLoading} />
      <section className="mon-fleet" aria-label="Fleet">
        <Card as="div" title="Agents" description="Registered agents: today's runs and error rate, last-24h p95." padding="none">
          <FleetTable
            agents={agents.data ?? []}
            insights={fleetInsights.data?.agents}
            loading={agents.loading && agents.data === undefined}
          />
        </Card>
      </section>
      {chartsLoading ? (
        <MonitoringChartsLoading />
      ) : windowRows.length === 0 ? (
        <MonitoringChartsEmpty />
      ) : (
        <MonitoringCharts
          rows={windowRows}
          window={chart}
          agentLabel={labelOf}
          onBucketClick={(from, to) => navigate(bucketTracesPath(from, to, agentId))}
        />
      )}
    </div>
  );
}
