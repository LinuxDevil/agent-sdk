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

const COLUMNS: Column<FleetRow>[] = [
  {
    key: 'agent',
    header: 'Agent',
    render: ({ agent }) => (
      <span className="mon-agent" title={agent.agent_id}>
        {agentLabel(agent)}
        {agent.version && <span className="mon-meta"> v{agent.version}</span>}
      </span>
    ),
  },
  { key: 'status', header: 'Status', render: ({ agent }) => <StatusPill status={agent.status} /> },
  {
    key: 'heartbeat',
    header: 'Last heartbeat',
    render: ({ agent }) => <span title={hostTitle(agent)}>{fmtAge(agent.heartbeat_age_ms)}</span>,
  },
  { key: 'runs', header: 'Runs today', align: 'right', render: ({ agent }) => fmtInt(agent.runs_today) },
  { key: 'error_rate', header: 'Error rate', align: 'right', render: ({ agent }) => fmtPercent(agent.error_rate_today) },
  { key: 'p95', header: 'p95 (24h)', align: 'right', hideBelow: 560, render: ({ p95 }) => fmtDuration(p95) },
  {
    key: 'dropped',
    header: 'Dropped events',
    label: 'Dropped events',
    align: 'right',
    hideBelow: 480,
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
    render: ({ agent }) => (
      <a className="mon-link" href={`#/traces?agent=${encodeURIComponent(agent.agent_id)}`}>
        Traces
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
