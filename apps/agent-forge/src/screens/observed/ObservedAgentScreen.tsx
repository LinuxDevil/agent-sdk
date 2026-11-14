/**
 * `#/observed/:agentId` (W07b): one observed agent, read-only - every
 * daemon instance reporting the same project+name, the merged recent runs
 * and scores, and the newest instance's eval pass rates. Data comes from
 * `useObservedAgent` (the observe daemon via the `/observe` proxy); there
 * is nothing to edit, so the page has no actions beyond navigation.
 *
 * States: loading skeletons per card; an unknown id gets "Agent not
 * found"; a collector failure gets "Could not reach the collector" with
 * Retry (the route id stays in the URL, so a retry refetches in place).
 */
import './observedAgent.css';
import { useMemo, type ReactNode } from 'react';
import { Bot, Radio } from 'lucide-react';
import { matchRoute, navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { TraceTokens } from '../../observe/chrome';
import { fmtAge, fmtCost, fmtDuration, fmtStarted } from '../../observe/format';
import type { ObserveAgentRow, ObserveScoreRow, ObserveTraceRow } from '../../observe/types';
import { ScreenHeader } from '../../shell/ScreenHeader';
import { Card } from '../../ui/Card';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import { StatusPill } from '../../ui/StatusPill';
import { useObservedAgent, type ObservedAgentData } from './useObservedAgent';

/** One `#/observed/:agentId` route entry point: reads the id off the hash and keys the screen on it. */
export function ObservedAgentRoute() {
  const { path } = useRoute();
  const agentId = matchRoute(`#${path}`, ['/observed/:agentId'])?.params.agentId ?? '';
  return <ObservedAgentScreen key={agentId} agentId={agentId} />;
}

/** The "Last seen" cell: heartbeat (or first sighting) as a relative age with the absolute time as tooltip. */
function LastSeen({ row, now }: { row: ObserveAgentRow; now: number }) {
  const at = row.last_heartbeat ?? row.first_seen;
  const date = new Date(at);
  const valid = !Number.isNaN(date.getTime());
  return (
    <time dateTime={valid ? date.toISOString() : undefined} title={valid ? date.toLocaleString() : undefined}>
      {valid ? fmtAge(now - date.getTime()) : 'never'}
    </time>
  );
}

/** A DataTable's empty cell: one muted line (the kit's EmptyState needs a hint or action; a table cell wants neither). */
function TableEmpty({ children }: { children: ReactNode }) {
  return <span className="observed-table-empty">{children}</span>;
}

function instanceColumns(now: number): Column<ObserveAgentRow>[] {
  return [
    {
      key: 'instance',
      header: 'Instance',
      width: 110,
      render: (r) => (
        <span className="observed-mono" title={r.agent_id}>
          {r.agent_id.slice(0, 8)}
        </span>
      ),
    },
    { key: 'host', header: 'Host', minWidth: 100, render: (r) => r.hostname ?? '-' },
    { key: 'pid', header: 'PID', width: 70, align: 'right', render: (r) => (r.pid === null ? '-' : String(r.pid)) },
    { key: 'version', header: 'Version', minWidth: 80, render: (r) => r.version ?? '-' },
    { key: 'status', header: 'Status', width: 100, render: (r) => <StatusPill status={r.status} /> },
    { key: 'lastSeen', header: 'Last seen', width: 90, hideBelow: 560, render: (r) => <LastSeen row={r} now={now} /> },
  ];
}

function runColumns(now: number): Column<ObserveTraceRow>[] {
  return [
    { key: 'started', header: 'Started', width: 110, render: (t) => fmtStarted(t.start, now) },
    { key: 'status', header: 'Status', width: 100, render: (t) => <StatusPill status={t.status} /> },
    { key: 'duration', header: 'Duration', align: 'right', width: 90, render: (t) => fmtDuration(t.end - t.start) },
    {
      key: 'tokens',
      header: 'Tokens',
      align: 'right',
      width: 86,
      hideBelow: 600,
      render: (t) => <TraceTokens trace={t} />,
    },
    { key: 'cost', header: 'Cost', align: 'right', width: 84, hideBelow: 600, render: (t) => fmtCost(t.cost_usd) },
  ];
}

function scoreColumns(now: number): Column<ObserveScoreRow>[] {
  return [
    { key: 'when', header: 'When', width: 110, render: (s) => fmtStarted(s.created_at, now) },
    { key: 'name', header: 'Name', minWidth: 120, render: (s) => s.name },
    { key: 'value', header: 'Value', width: 80, align: 'right', render: (s) => (s.value === null ? '-' : String(s.value)) },
    { key: 'source', header: 'Source', width: 90, hideBelow: 720, render: (s) => s.source },
    {
      key: 'trace',
      header: 'Trace',
      width: 110,
      hideBelow: 900,
      render: (s) => (
        <a className="observed-trace-link" href={`#/traces/${encodeURIComponent(s.trace_id)}`} title={s.trace_id}>
          {s.trace_id.slice(0, 12)}
        </a>
      ),
    },
  ];
}

/** A shimmer block standing in for one card's table while the page loads. */
function LoadingCard({ title }: { title: string }) {
  return (
    <Card title={title}>
      <div className="observed-loading" aria-hidden="true">
        <Skeleton width="40%" height={12} />
        <Skeleton width="70%" height={12} />
        <Skeleton width="55%" height={12} />
      </div>
    </Card>
  );
}

interface ObservedAgentScreenProps {
  /** The route's `:agentId` - a daemon `agent_id`. */
  agentId: string;
}

/**
 * The observed agent page body: header (name + read-only description +
 * breadcrumbs) over the four data cards, or one of the three states.
 */
export function ObservedAgentScreen({ agentId }: ObservedAgentScreenProps) {
  const { data, loading, error, notFound, refresh } = useObservedAgent(agentId);
  // One "now" per loaded answer, so the relative ages don't drift mid-view.
  const now = useMemo(() => Date.now(), [agentId, data]);

  if (notFound) {
    return (
      <>
        <ScreenHeader title="Observed agent" breadcrumbs={[{ label: 'Agents', href: '#/agents' }]} />
        <EmptyState
          icon={Bot}
          title="Agent not found"
          hint="The collector has no agent with this id."
          action={
            <a className="btn btn-secondary btn-sm" href="#/agents">
              Back to agents
            </a>
          }
        />
      </>
    );
  }
  if (error !== undefined && data === undefined) {
    return (
      <>
        <ScreenHeader title="Observed agent" breadcrumbs={[{ label: 'Agents', href: '#/agents' }]} />
        <EmptyState
          icon={Radio}
          title="Could not reach the collector"
          hint={error}
          action={
            <button type="button" className="btn btn-secondary btn-sm" onClick={refresh}>
              Retry
            </button>
          }
        />
      </>
    );
  }

  const name = data?.instances[0]?.name ?? agentId;
  const project = data?.instances[0]?.project ?? null;
  return (
    <>
      <ScreenHeader
        title={name}
        description={`Read-only. Reported by ${project ?? 'an agent with no project'} to the collector.`}
        breadcrumbs={[{ label: 'Agents', href: '#/agents' }, { label: name }]}
      />
      <div className="observed-agent-screen">
        {loading || data === undefined ? (
          <>
            <LoadingCard title="Instances" />
            <LoadingCard title="Recent runs" />
            <LoadingCard title="Scores" />
            <LoadingCard title="Evals" />
          </>
        ) : (
          <ObservedAgentBody data={data} now={now} />
        )}
      </div>
    </>
  );
}

/** The loaded page: the four cards. */
function ObservedAgentBody({ data, now }: { data: ObservedAgentData; now: number }) {
  return (
    <>
      <Card title="Instances" padding="none">
        <DataTable
          id="observed-instances"
          columns={instanceColumns(now)}
          rows={data.instances}
          rowKey={(r) => r.agent_id}
          empty={<TableEmpty>No instances</TableEmpty>}
        />
      </Card>
      <Card title="Recent runs" padding="none">
        <DataTable
          id="observed-runs"
          columns={runColumns(now)}
          rows={data.traces}
          rowKey={(t) => t.trace_id}
          onRowOpen={(t) => navigate(`/traces/${encodeURIComponent(t.trace_id)}`)}
          empty={<TableEmpty>No runs reported yet.</TableEmpty>}
        />
      </Card>
      <Card title="Scores" padding="none">
        <DataTable
          id="observed-scores"
          columns={scoreColumns(now)}
          rows={data.scores}
          rowKey={(s) => s.score_id}
          empty={<TableEmpty>No scores yet.</TableEmpty>}
        />
      </Card>
      <Card title="Evals">
        {data.passRates.length === 0 ? (
          <p className="observed-evals-empty">No eval results yet.</p>
        ) : (
          <ul className="observed-evals">
            {data.passRates.map((rate) => (
              <li key={rate.name}>
                {rate.name} — {rate.passed}/{rate.count} passed
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
