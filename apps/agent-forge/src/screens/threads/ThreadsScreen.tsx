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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MessagesSquare, RefreshCw } from 'lucide-react';
import { matchRoute, navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useAgents, useDaemonDown, useDaemonHealth, useSessions } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import type { ObserveSessionRow } from '../../observe/types';
import { fmtAge, fmtCost, fmtDateTime, fmtDuration, fmtInt, fmtStarted } from '../../observe/format';
import { Card } from '../../ui/Card';
import { DataTable, type Column } from '../../ui/DataTable';
import { FilterBar } from '../../ui/FilterBar';
import { EmptyState } from '../../ui/EmptyState';
import { StatusPill } from '../../ui/StatusPill';
import { ScreenHeader } from '../../shell/ScreenHeader';
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

/**
 * Session statuses the daemon writes: `active`; `ended` once its idle sweep sees
 * nothing run for the idle window; `interrupted` when the agent's crash sweep
 * closes it. New activity makes an ended or interrupted session `active` again.
 */
const STATUSES = ['active', 'ended', 'interrupted'];

/** The session's span, start to its latest finished observation; `-` while nothing has finished. */
const span = (s: ObserveSessionRow): number | null => (s.ended_at === null ? null : s.ended_at - s.started_at);

/** The latest activity: the last finished observation, else the start. */
const lastActivity = (s: ObserveSessionRow): number => s.ended_at ?? s.started_at;

/** The thread cell: the last input (500) over the session id (mono, faint). */
function ThreadCell({ session }: { session: ObserveSessionRow }) {
  return (
    <span className="threads-name">
      {session.last_input_preview ? (
        <Clip text={session.last_input_preview} className="threads-name-title" />
      ) : (
        <span className="threads-name-title threads-name-none">No input recorded</span>
      )}
      <span className="threads-name-id" title={session.session_id}>
        {session.session_id}
      </span>
    </span>
  );
}

/** "3m ago", with the start and the absolute last activity in the tooltip. */
function ActivityCell({ session, now }: { session: ObserveSessionRow; now: number }) {
  const last = lastActivity(session);
  return (
    <span className="threads-num" title={`Started ${fmtDateTime(session.started_at)} · last activity ${fmtDateTime(last)}`}>
      {fmtAge(Math.max(0, now - last))}
    </span>
  );
}

/**
 * The list's columns, sized so the table fits a 1280 px window with the nav
 * expanded (and the header stays sticky): the thread cell takes the flexible
 * width; the start and the span appear on wider screens (the start also rides
 * in the last-activity tooltip), and a phone keeps status and thread.
 */
function columns(now: number): Column<ObserveSessionRow>[] {
  return [
    { key: 'status', header: 'Status', width: 128, render: (s) => <StatusPill status={s.status} /> },
    { key: 'session', header: 'Thread', minWidth: 160, render: (s) => <ThreadCell session={s} /> },
    { key: 'agent', header: 'Agent', width: 132, hideBelow: 720, render: (s) => <Clip text={s.agent_name ?? s.agent_id} /> },
    { key: 'turns', header: 'Turns', align: 'right', width: 68, hideBelow: 480, render: (s) => fmtInt(s.traces) },
    { key: 'activity', header: 'Last activity', width: 112, hideBelow: 560, render: (s) => <ActivityCell session={s} now={now} /> },
    {
      key: 'started',
      header: 'Started',
      width: 120,
      hideBelow: 1400,
      render: (s) => <span className="threads-num">{fmtStarted(s.started_at, now)}</span>,
    },
    { key: 'duration', header: 'Duration', align: 'right', width: 96, hideBelow: 1300, render: (s) => fmtDuration(span(s)) },
    {
      key: 'tokens',
      header: 'Tokens',
      align: 'right',
      width: 86,
      hideBelow: 600,
      render: (s) => (
        <span title={`${fmtInt(s.input_tokens)} in / ${fmtInt(s.output_tokens)} out`}>{fmtInt(s.input_tokens + s.output_tokens)}</span>
      ),
    },
    { key: 'cost', header: 'Cost', align: 'right', width: 84, hideBelow: 640, render: (s) => fmtCost(s.cost_usd) },
  ];
}

function ThreadsList({ refreshKey }: { refreshKey: number }) {
  const route = useRoute();
  const queryString = route.query.toString();
  const state = useMemo(() => parseThreadsQuery(route.query), [queryString]);
  // One "now" per URL (and per refresh), so the rolling default window doesn't refetch every render.
  const now = useMemo(() => Date.now(), [queryString, refreshKey]);
  const filter = useMemo(() => toSessionFilter(state, now), [state, now]);
  const sessions = useSessions(filter, refreshKey);
  const agents = useAgents();
  const down = useDaemonDown(false, [sessions, agents]);

  useEffect(() => rememberThreadsQuery(formatThreadsQuery(state)), [state]);

  // Every filter edit restarts at the first page; replace keeps Back off the filter edits.
  const update = (patch: Partial<ThreadsUrlState>) =>
    navigate(`/threads${formatThreadsQuery({ ...state, offset: 0, ...patch })}`, { replace: true });
  const range = useRangeFilter(state.window, DEFAULT_THREADS_RANGE, (window) => update({ window }));
  const facets = [
    agentFacet(agents.data ?? [], state.agent, (agent) => update({ agent })),
    facet('status', 'Status', STATUSES, state.status, (status) => update({ status })),
  ];
  if (down) return <ObserveDaemonDown />;

  return (
    <section className="threads-screen" aria-label="Threads">
      <h2 className="visually-hidden">Threads</h2>
      <FilterBar facets={facets} range={range} />
      <ObserveError error={sessions.error} />
      <Card as="div" padding="none" className="threads-card">
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
          density="comfortable"
          loading={sessions.loading}
          empty={
            <EmptyState
              icon={MessagesSquare}
              title="No threads match these filters"
              hint="A thread appears once agent runs carry a sessionId. Try a wider time range."
            />
          }
        />
      </Card>
    </section>
  );
}

/** `#/threads` under its page header (Refresh re-fetches now), behind the daemon-down state. */
function ThreadsListScreen() {
  const health = useDaemonHealth();
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);
  return (
    <>
      <ScreenHeader
        title="Threads"
        status={null}
        description="Conversations grouped by session"
        actions={
          <button type="button" className="btn btn-icon" aria-label="Refresh" title="Refresh" disabled={health.down} onClick={bump}>
            <RefreshCw aria-hidden="true" />
          </button>
        }
      />
      {health.down ? <ObserveDaemonDown /> : <ThreadsList refreshKey={refreshKey} />}
    </>
  );
}

/** `#/threads` and `#/threads/:sessionId`; each sets its own page header and daemon-down state. */
export function ThreadsScreen() {
  const { path } = useRoute();
  const detail = matchRoute(`#${path}`, ['/threads/:sessionId']);
  return detail ? <ThreadScreen sessionId={detail.params.sessionId} /> : <ThreadsListScreen />;
}
