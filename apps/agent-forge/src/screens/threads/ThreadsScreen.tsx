/**
 * `#/threads` - the session list (agent / status / time-range facets,
 * server-side paging over `GET /api/v1/sessions`) - and
 * `#/threads/:sessionId`, one conversation (see `ThreadScreen.tsx`).
 *
 * All list state lives in the URL query (see `threadsUrl.ts` for the keys).
 * Filter and page edits replace the current history entry; opening a thread
 * pushes one, so Back returns to the list. Both routes sit behind the
 * daemon-down state, which keeps the URL and swaps the screen back in by
 * itself once the health probe sees the daemon.
 */
import './threads.css';
import { useEffect, useMemo } from 'react';
import { matchRoute, navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useAgents, useDaemonHealth, useSessions } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { ObserveDaemonDownError } from '../../observe/observeClient';
import type { ObserveSessionRow } from '../../observe/types';
import { fmtCost, fmtDuration, fmtInt, fmtStarted } from '../../observe/format';
import { DataTable, type Column } from '../../ui/DataTable';
import { FilterBar } from '../../ui/FilterBar';
import { EmptyState } from '../../ui/EmptyState';
import { StatusPill } from '../../ui/StatusPill';
import { Clip, agentFacet, facet, useRangeFilter } from '../listFilters';
import { ThreadScreen } from './ThreadScreen';
import {
  DEFAULT_THREADS_RANGE,
  THREADS_PAGE_SIZE,
  formatThreadsQuery,
  parseThreadsQuery,
  rememberThreadsQuery,
  toSessionFilter,
  type ThreadsUrlState,
} from './threadsUrl';

/** Session statuses the daemon writes: `active`, then `interrupted` when the agent's crash sweep closes it. */
const STATUSES = ['active', 'interrupted'];

/** The session's span, start to its latest finished observation; `-` while nothing has finished. */
const span = (s: ObserveSessionRow): number | null => (s.ended_at === null ? null : s.ended_at - s.started_at);

function columns(now: number): Column<ObserveSessionRow>[] {
  return [
    { key: 'status', header: 'Status', width: 110, render: (s) => <StatusPill status={s.status} /> },
    {
      key: 'session',
      header: 'Session',
      width: 130,
      render: (s) => <span title={s.session_id}>{s.session_id.slice(0, 12)}</span>,
    },
    { key: 'agent', header: 'Agent', width: 130, hideBelow: 720, render: (s) => <Clip text={s.agent_name ?? s.agent_id} /> },
    { key: 'input', header: 'Last input', width: 240, render: (s) => <Clip text={s.last_input_preview} /> },
    { key: 'turns', header: 'Turns', align: 'right', width: 70, render: (s) => fmtInt(s.traces) },
    { key: 'started', header: 'Started', width: 130, hideBelow: 900, render: (s) => fmtStarted(s.started_at, now) },
    {
      key: 'duration',
      header: 'Duration',
      align: 'right',
      width: 96,
      hideBelow: 1000,
      render: (s) => (
        <span title={s.ended_at === null ? undefined : `Last activity ${fmtStarted(s.ended_at, now)}`}>{fmtDuration(span(s))}</span>
      ),
    },
    {
      key: 'tokens',
      header: 'Tokens',
      align: 'right',
      width: 90,
      render: (s) => (
        <span title={`${fmtInt(s.input_tokens)} in / ${fmtInt(s.output_tokens)} out`}>{fmtInt(s.input_tokens + s.output_tokens)}</span>
      ),
    },
    { key: 'cost', header: 'Cost', align: 'right', width: 84, hideBelow: 720, render: (s) => fmtCost(s.cost_usd) },
  ];
}

function ThreadsList() {
  const route = useRoute();
  const queryString = route.query.toString();
  const state = useMemo(() => parseThreadsQuery(route.query), [queryString]);
  // One "now" per URL, so the rolling default window doesn't refetch every render.
  const now = useMemo(() => Date.now(), [queryString]);
  const filter = useMemo(() => toSessionFilter(state, now), [state, now]);
  const sessions = useSessions(filter);
  const agents = useAgents();

  useEffect(() => rememberThreadsQuery(formatThreadsQuery(state)), [state]);

  // Every filter edit restarts at the first page; replace keeps Back off the filter edits.
  const update = (patch: Partial<ThreadsUrlState>) =>
    navigate(`/threads${formatThreadsQuery({ ...state, offset: 0, ...patch })}`, { replace: true });
  const range = useRangeFilter(state.window, DEFAULT_THREADS_RANGE, (window) => update({ window }));
  const facets = [
    agentFacet(agents.data ?? [], state.agent, (agent) => update({ agent })),
    facet('status', 'Status', STATUSES, state.status, (status) => update({ status })),
  ];
  if (sessions.error instanceof ObserveDaemonDownError) return <ObserveDaemonDown />;

  return (
    <section className="threads-screen" aria-label="Threads">
      <h2 className="visually-hidden">Threads</h2>
      <FilterBar facets={facets} range={range} />
      <ObserveError error={sessions.error} />
      <DataTable
        id="threads"
        columns={columns(now)}
        rows={sessions.data?.sessions ?? []}
        rowKey={(s) => s.session_id}
        onRowOpen={(s) => navigate(`/threads/${encodeURIComponent(s.session_id)}`)}
        page={{
          offset: state.offset,
          limit: THREADS_PAGE_SIZE,
          total: sessions.data?.total ?? 0,
          onChange: (offset) => update({ offset }),
        }}
        loading={sessions.loading}
        empty={
          <EmptyState
            title="No threads match these filters"
            hint="A thread appears once agent runs carry a sessionId. Try a wider time range."
          />
        }
      />
    </section>
  );
}

/** `#/threads` and `#/threads/:sessionId`, behind the daemon-down state. */
export function ThreadsScreen() {
  const { path } = useRoute();
  const health = useDaemonHealth();
  if (health.down) return <ObserveDaemonDown />;
  const detail = matchRoute(`#${path}`, ['/threads/:sessionId']);
  return detail ? <ThreadScreen sessionId={detail.params.sessionId} /> : <ThreadsList />;
}
