import { ArrowUpRight, Bot } from 'lucide-react';
import type { CSSProperties } from 'react';

import { fmtAge, fmtDuration, fmtInt, fmtPercent } from '../../observe/format';
import type { ObserveAgentInsights, ObserveAgentRow } from '../../observe/types';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { StatusPill } from '../../ui/StatusPill';

/** A fleet row: the registry entry plus its last-24h p95 from insights. */
interface FleetRow {
  agent: ObserveAgentRow;
  p95: number | null | undefined;
}

export const agentLabel = (agent: Pick<ObserveAgentRow, 'agent_id' | 'name'>): string =>
  agent.name ?? agent.agent_id.slice(0, 8);

function hostTitle(agent: ObserveAgentRow): string | undefined {
  if (!agent.hostname) return undefined;
  return agent.pid ? `${agent.hostname} pid ${agent.pid}` : agent.hostname;
}

/** Error rates above this read as a problem (danger tone on the inline bar). */
const HIGH_ERROR_RATE = 0.05;
/** The inline bar is full at this error rate, so the usual few-percent rates still show. */
const BAR_FULL_RATE = 0.1;

/** The day's error rate as a figure beside a small bar (full at {@link BAR_FULL_RATE}). */
function ErrorRate({ rate }: { rate: number | null | undefined }) {
  const known = rate !== null && rate !== undefined && Number.isFinite(rate);
  const fill = known ? Math.min(1, Math.max(0, rate / BAR_FULL_RATE)) : 0;
  return (
    <span className="mon-rate" data-high={known && rate > HIGH_ERROR_RATE ? 'true' : undefined}>
      <span className="mon-rate-value">{fmtPercent(rate)}</span>
      <span className="mon-rate-bar" aria-hidden="true">
        <span className="mon-rate-fill" style={{ '--fill': `${(fill * 100).toFixed(1)}%` } as CSSProperties} />
      </span>
    </span>
  );
}

const COLUMNS: Column<FleetRow>[] = [
  {
    key: 'agent',
    header: 'Agent',
    render: ({ agent }) => (
      <span className="mon-agent" title={agent.agent_id}>
        <span className="mon-agent-name">{agentLabel(agent)}</span>
        {agent.version && <span className="mon-meta">v{agent.version}</span>}
      </span>
    ),
  },
  { key: 'status', header: 'Health', width: 104, render: ({ agent }) => <StatusPill status={agent.status} /> },
  {
    key: 'heartbeat',
    header: 'Last heartbeat',
    width: 116,
    hideBelow: 880,
    render: ({ agent }) => <span title={hostTitle(agent)}>{fmtAge(agent.heartbeat_age_ms)}</span>,
  },
  { key: 'runs', header: 'Runs', label: 'Runs today', width: 72, align: 'right', hideBelow: 420, render: ({ agent }) => fmtInt(agent.runs_today) },
  { key: 'error_rate', header: 'Error rate', width: 120, align: 'right', hideBelow: 480, render: ({ agent }) => <ErrorRate rate={agent.error_rate_today} /> },
  { key: 'p95', header: 'p95', label: 'p95 (24h)', width: 72, align: 'right', hideBelow: 640, render: ({ p95 }) => fmtDuration(p95) },
  {
    key: 'dropped',
    header: 'Dropped',
    label: 'Dropped events',
    width: 80,
    align: 'right',
    hideBelow: 720,
    render: ({ agent }) => (
      <span className={agent.dropped ? 'mon-dropped' : undefined} data-dropped={agent.dropped ?? ''}>
        {agent.dropped === null || agent.dropped === undefined ? '—' : fmtInt(agent.dropped)}
      </span>
    ),
  },
  {
    key: 'traces',
    header: <span className="visually-hidden">Traces</span>,
    label: 'Traces',
    width: 128,
    render: ({ agent }) => (
      <a className="btn btn-ghost btn-sm mon-traces-link" href={`#/traces?agent=${encodeURIComponent(agent.agent_id)}`}>
        View traces<span className="visually-hidden"> for {agentLabel(agent)}</span>
        <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" />
      </a>
    ),
  },
];

/**
 * The fleet: every registered agent with its derived status, last heartbeat,
 * today's runs and error rate (the daemon's day rollup), last-24h p95, the
 * reporter's dropped-event count, and a link to that agent's traces.
 */
export function FleetTable({
  agents,
  insights,
  loading,
}: {
  agents: ObserveAgentRow[];
  insights: ObserveAgentInsights[] | undefined;
  loading: boolean;
}) {
  const p95 = new Map((insights ?? []).map((a) => [a.agent_id, a.p95_latency_ms]));
  const rows = agents.map((agent) => ({ agent, p95: p95.get(agent.agent_id) }));
  return (
    <DataTable
      id="monitoring-fleet"
      columns={COLUMNS}
      rows={rows}
      rowKey={(r) => r.agent.agent_id}
      loading={loading}
      density="compact"
      empty={
        <EmptyState
          icon={Bot}
          title="No agents registered yet"
          hint={
            <>
              An agent registers on its first emit when <code>LOUSHO_OBSERVE=1</code> is set.
            </>
          }
        />
      }
    />
  );
}
