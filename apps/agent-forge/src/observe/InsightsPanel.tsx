import { useMemo, useState } from 'react';
import { useInsights } from './useObserve';
import type { ObserveAgentInsights, ObserveRollupRow } from './types';
import { fmtCost, fmtDuration, fmtInt, fmtPercent } from './format';
import { ObserveDaemonDown, ObserveError } from './chrome';
import { ObserveDaemonDownError } from './observeClient';

const DAY_OPTIONS = [1, 7, 30] as const;
const METRICS = [
  { id: 'runs', label: 'Runs' },
  { id: 'errors', label: 'Errors' },
  { id: 'cost_usd', label: 'Cost ($)' },
  { id: 'input_tokens', label: 'Input tokens' },
  { id: 'output_tokens', label: 'Output tokens' },
] as const;
type MetricId = (typeof METRICS)[number]['id'];

function fmtMetric(metric: MetricId, value: number): string {
  return metric === 'cost_usd' ? fmtCost(value) : fmtInt(value);
}

/** One agent's aggregate card: runs/day, p50/p95, cost, error rate - the numbers the spec's Insights section names. */
function AgentCard({ agent }: { agent: ObserveAgentInsights }) {
  return (
    <div className="agent-card insight-card">
      <div className="agent-card-top">
        <span className="agent-name">{agent.name ?? agent.agent_id.slice(0, 8)}</span>
        {agent.project && <span className="chip">{agent.project}</span>}
      </div>
      <div className="insight-grid">
        <div className="insight-stat">
          <span className="insight-value">{agent.runs_per_day.toFixed(1)}</span>
          <span className="insight-label">runs/day</span>
        </div>
        <div className="insight-stat">
          <span className="insight-value">{fmtDuration(agent.p50_latency_ms)}</span>
          <span className="insight-label">p50</span>
        </div>
        <div className="insight-stat">
          <span className="insight-value">{fmtDuration(agent.p95_latency_ms)}</span>
          <span className="insight-label">p95</span>
        </div>
        <div className="insight-stat">
          <span className="insight-value">{fmtCost(agent.cost_usd)}</span>
          <span className="insight-label">cost</span>
        </div>
        <div className="insight-stat">
          <span className={`insight-value${agent.error_rate > 0 ? ' insight-bad' : ''}`}>
            {fmtPercent(agent.error_rate)}
          </span>
          <span className="insight-label">error rate</span>
        </div>
        <div className="insight-stat">
          <span className="insight-value">{fmtInt(agent.input_tokens + agent.output_tokens)}</span>
          <span className="insight-label">tokens</span>
        </div>
      </div>
    </div>
  );
}

interface Bucket {
  start: number;
  value: number;
}

/** Sum every agent's rollup rows into one (bucket_start -> value) series for `metric`. */
function metricBuckets(series: ObserveRollupRow[], metric: MetricId): Bucket[] {
  const byBucket = new Map<number, number>();
  for (const row of series) {
    if (row.metric !== metric) continue;
    byBucket.set(row.bucket_start, (byBucket.get(row.bucket_start) ?? 0) + row.value);
  }
  return [...byBucket.entries()].sort(([a], [b]) => a - b).map(([start, value]) => ({ start, value }));
}

/** Minimal bar chart - plain divs, no chart dependency. */
function MetricChart({ buckets, metric }: { buckets: Bucket[]; metric: MetricId }) {
  const max = Math.max(...buckets.map((b) => b.value), 0);
  if (buckets.length === 0) return <div className="observe-empty"><p>No rollup rows in this window yet.</p></div>;
  return (
    <div className="insight-chart" role="img" aria-label={`${metric} per bucket`}>
      {buckets.map((bucket) => (
        <div
          key={bucket.start}
          className="insight-bar"
          title={`${new Date(bucket.start).toLocaleString()} - ${fmtMetric(metric, bucket.value)}`}
          style={{ height: `${Math.max(2, (bucket.value / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

/**
 * `GET /api/v1/insights` - per-agent aggregate cards plus the rollup time
 * series. Aggregates come from the daemon's `rollups` table; the panel only
 * picks the window (days) and which metric the chart draws.
 */
export function InsightsPanel() {
  const [days, setDays] = useState<number>(7);
  const [metric, setMetric] = useState<MetricId>('runs');
  const { data, error, loading } = useInsights({ days, granularity: days <= 1 ? 'hour' : 'day' });
  const buckets = useMemo(() => metricBuckets(data?.series ?? [], metric), [data, metric]);

  if (error instanceof ObserveDaemonDownError) return <ObserveDaemonDown />;

  return (
    <div className="observe-panel">
      <div className="observe-filter-bar">
        <label>
          Window
          <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DAY_OPTIONS.map((d) => (
              <option key={d} value={d}>
                Last {d === 1 ? '24 hours' : `${d} days`}
              </option>
            ))}
          </select>
        </label>
        <label>
          Metric
          <select className="select" value={metric} onChange={(e) => setMetric(e.target.value as MetricId)}>
            {METRICS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ObserveError error={error} />
      {loading && data === undefined ? (
        <div className="observe-loading">Loading insights...</div>
      ) : (data?.agents.length ?? 0) === 0 ? (
        <div className="observe-empty">
          <p>No rollup data in this window - Insights fills in as agents report runs.</p>
        </div>
      ) : (
        <>
          <div className="insight-cards">
            {data!.agents.map((agent) => (
              <AgentCard key={agent.agent_id} agent={agent} />
            ))}
          </div>
          <div className="rail-section-title">
            {METRICS.find((m) => m.id === metric)?.label} per {days <= 1 ? 'hour' : 'day'} (all agents)
          </div>
          <MetricChart buckets={buckets} metric={metric} />
        </>
      )}
    </div>
  );
}
