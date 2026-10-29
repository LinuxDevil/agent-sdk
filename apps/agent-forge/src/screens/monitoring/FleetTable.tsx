import { ArrowUpRight, Bot } from 'lucide-react';
import { useMemo, type CSSProperties } from 'react';

import { useMediaQuery } from '../../components/useMediaQuery';
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

/** At phone widths the table drops to compact columns: an icon-only traces link, no error bar. */
const COMPACT_QUERY = '(max-width: 600px)';

function AgentCell({ agent }: { agent: ObserveAgentRow }) {
  const label = agentLabel(agent);
  return (
    <span className="mon-agent">
      <span className="mon-agent-name" title={label === agent.agent_id ? label : `${label} — ${agent.agent_id}`}>
        {label}
      </span>
      {agent.version && <span className="mon-meta">v{agent.version}</span>}
    </span>
  );
}

function TracesLink({ agent, compact }: { agent: ObserveAgentRow; compact: boolean }) {
  const label = agentLabel(agent);
  return (
    <a
      className={`btn btn-ghost btn-sm mon-traces-link${compact ? ' btn-icon' : ''}`}
      href={`#/traces?agent=${encodeURIComponent(agent.agent_id)}`}
      title={compact ? `View traces for ${label}` : undefined}
    >
      {compact ? <span className="visually-hidden">View traces for {label}</span> : <>View traces<span className="visually-hidden"> for {label}</span></>}
      <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" />
    </a>
  );
}

function DroppedCell({ dropped }: { dropped: number | null | undefined }) {
  return (
    <span className={dropped ? 'mon-dropped' : undefined} data-dropped={dropped ?? ''}>
      {dropped === null || dropped === undefined ? '—' : fmtInt(dropped)}
    </span>
  );
}

/**
 * The fleet columns. Fixed widths for everything but the agent name, which takes the rest;
 * columns drop out as the table narrows, and `compact` (phone widths) slims the ones that stay
 * (health becomes its dot) so the name, health, runs and error rate still fit at 375 px.
 */
function fleetColumns(compact: boolean): Column<FleetRow>[] {
  return [
    { key: 'agent', header: 'Agent', render: ({ agent }) => <AgentCell agent={agent} /> },
    compact
      ? {
          // Dot only: the pill's label stays in the DOM, visually hidden, and is the dot's tooltip.
          key: 'status',
          header: <span className="visually-hidden">Health</span>,
          label: 'Health',
          width: 32,
          render: ({ agent }) => (
            <span className="mon-health-dot" title={agent.status}>
              <StatusPill status={agent.status} />
            </span>
          ),
        }
      : { key: 'status', header: 'Health', width: 104, render: ({ agent }) => <StatusPill status={agent.status} /> },
    {
      key: 'heartbeat',
      header: 'Last heartbeat',
      width: 116,
      hideBelow: 880,
      render: ({ agent }) => <span title={hostTitle(agent)}>{fmtAge(agent.heartbeat_age_ms)}</span>,
    },
    {
      key: 'runs',
      header: 'Runs',
      label: 'Runs today',
      width: compact ? 56 : 72,
      align: 'right',
      hideBelow: 280,
      render: ({ agent }) => fmtInt(agent.runs_today),
    },
    {
      key: 'error_rate',
      header: compact ? 'Errors' : 'Error rate',
      label: 'Error rate',
      width: compact ? 60 : 120,
      align: 'right',
      hideBelow: 300,
      render: ({ agent }) => <ErrorRate rate={agent.error_rate_today} />,
    },
    { key: 'p95', header: 'p95', label: 'p95 (24h)', width: 72, align: 'right', hideBelow: 640, render: ({ p95 }) => fmtDuration(p95) },
    {
      key: 'dropped',
      header: 'Dropped',
      label: 'Dropped events',
      width: 80,
      align: 'right',
      hideBelow: 720,
      render: ({ agent }) => <DroppedCell dropped={agent.dropped} />,
    },
    {
      key: 'traces',
      header: <span className="visually-hidden">Traces</span>,
      label: 'Traces',
      width: compact ? 44 : 128,
      render: ({ agent }) => <TracesLink agent={agent} compact={compact} />,
    },
  ];
}

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
  const compact = useMediaQuery(COMPACT_QUERY);
  const columns = useMemo(() => fleetColumns(compact), [compact]);
  return (
    <DataTable
      id="monitoring-fleet"
      columns={columns}
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
