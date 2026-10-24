/**
 * `#/traces` - the trace list: search, facets, time range, server-side sort and
 * paging over `GET /api/v1/traces`. A row opens `#/traces/:traceId` (TraceScreen).
 *
 * All list state lives in the URL query (see `tracesUrl.ts` for the keys).
 * Filter, sort and page edits replace the current history entry, so Back
 * leaves the list instead of walking through filter edits; opening a trace
 * pushes an entry, so Back returns to the list. Both routes sit behind the
 * daemon-down state, which keeps the URL and swaps the screen back in by
 * itself once the health probe sees the daemon.
 */
import './traces.css';
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useAgents, useDaemonHealth, useTraces } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { ObserveDaemonDownError, type TraceSort } from '../../observe/observeClient';
import type { ObserveAgentRow, ObserveTraceRow } from '../../observe/types';
import { fmtCost, fmtDuration, fmtInt, fmtStarted } from '../../observe/format';
import { DataTable, type Column, type TableSort } from '../../ui/DataTable';
import { FilterBar, type FacetDef } from '../../ui/FilterBar';
import { formatTimeRange, toWindow, type TimeRange } from '../../ui/TimeRangePicker';
import { EmptyState } from '../../ui/EmptyState';
import { StatusPill } from '../../ui/StatusPill';
import {
  PAGE_SIZE,
  formatTracesQuery,
  parseTracesQuery,
  rememberListQuery,
  toTraceFilter,
  type TracesUrlState,
} from './tracesUrl';

const STATUSES = ['ok', 'error', 'running', 'interrupted'];
const SORTABLE: readonly string[] = ['duration', 'tokens', 'cost'];

/** A preview cell: one line, ellipsised by CSS, the full text in `title`. */
function Clip({ text, className = 'traces-clip' }: { text: string | null; className?: string }) {
  if (!text) return null;
  return (
    <span className={className} title={text}>
      {text}
    </span>
  );
}

function columns(now: number): Column<ObserveTraceRow>[] {
  return [
    { key: 'status', header: 'Status', width: 110, render: (t) => <StatusPill status={t.status} /> },
    {
      key: 'name',
      header: 'Name',
      width: 160,
      render: (t) => <Clip text={t.name ?? t.trace_id.slice(0, 12)} />,
    },
    { key: 'agent', header: 'Agent', width: 130, hideBelow: 720, render: (t) => <Clip text={t.agent_name ?? t.agent_id} /> },
    { key: 'input', header: 'Input', width: 200, hideBelow: 900, render: (t) => <Clip text={t.input_preview} /> },
    { key: 'output', header: 'Output', width: 200, hideBelow: 1100, render: (t) => <Clip text={t.output_preview} /> },
    {
      key: 'error',
      header: 'Error',
      width: 200,
      render: (t) => <Clip text={t.error_message} className="traces-clip traces-error" />,
    },
    { key: 'model', header: 'Model', width: 130, hideBelow: 1000, render: (t) => <Clip text={t.model} /> },
    { key: 'started', header: 'Started', width: 130, render: (t) => fmtStarted(t.start, now) },
    { key: 'duration', header: 'Duration', align: 'right', sortable: true, width: 96, render: (t) => fmtDuration(t.end - t.start) },
    {
      key: 'tokens',
      header: 'Tokens',
      align: 'right',
      sortable: true,
      width: 90,
      render: (t) => (
        <span title={`${fmtInt(t.input_tokens)} in / ${fmtInt(t.output_tokens)} out`}>
          {fmtInt(t.input_tokens + t.output_tokens)}
        </span>
      ),
    },
    { key: 'cost', header: 'Cost', align: 'right', sortable: true, width: 84, render: (t) => fmtCost(t.cost_usd) },
  ];
}

/** Single-value facet over FilterBar's multi-select: the newest pick wins, clearing it drops the filter. */
function facet(key: string, label: string, options: string[], value: string | undefined, set: (v: string | undefined) => void): FacetDef {
  const all = value && !options.includes(value) ? [value, ...options] : options;
  return {
    key,
    label,
    options: all.map((o) => ({ value: o, label: o })),
    value: value ? [value] : [],
    onChange: (next) => set(next.find((v) => v !== value) ?? (value && next.includes(value) ? value : undefined)),
  };
}

const uniqueSorted = (values: (string | null | undefined)[]): string[] =>
  [...new Set(values.filter((v): v is string => Boolean(v)))].sort();

function agentFacet(agents: ObserveAgentRow[], value: string | undefined, set: (v: string | undefined) => void): FacetDef {
  const def = facet('agent', 'Agent', agents.map((a) => a.agent_id), value, set);
  const names = new Map(agents.map((a) => [a.agent_id, a.name ?? a.agent_id.slice(0, 8)]));
  return { ...def, options: def.options.map((o) => ({ ...o, label: names.get(o.value) ?? o.value })) };
}

/**
 * The picker's value. The URL only holds absolute bounds; a preset picked here
 * is remembered alongside the bounds it produced, so the picker keeps showing
 * "7d" until the window changes (a reload then shows it as Custom).
 */
function rangeValue(state: TracesUrlState, picked: MutableRefObject<{ range: TimeRange; key: string } | undefined>): TimeRange {
  if (!state.window) return { preset: '24h' };
  const key = formatTimeRange(state.window);
  return picked.current?.key === key ? picked.current.range : state.window;
}

function TracesList() {
  const route = useRoute();
  const queryString = route.query.toString();
  const state = useMemo(() => parseTracesQuery(route.query), [queryString]);
  // One "now" per URL, so the rolling default window doesn't refetch every render.
  const now = useMemo(() => Date.now(), [queryString]);
  const filter = useMemo(() => toTraceFilter(state, now), [state, now]);
  const traces = useTraces(filter);
  const agents = useAgents();
  const picked = useRef<{ range: TimeRange; key: string } | undefined>(undefined);

  useEffect(() => rememberListQuery(formatTracesQuery(state)), [state]);

  // Every filter edit restarts at the first page; replace keeps Back off the filter edits.
  const update = (patch: Partial<TracesUrlState>) =>
    navigate(`/traces${formatTracesQuery({ ...state, offset: 0, ...patch })}`, { replace: true });
  const setText = (key: 'agent' | 'status' | 'model' | 'project' | 'q') => (v: string | undefined) => update({ [key]: v || undefined });

  const onRange = (r: TimeRange) => {
    if ('preset' in r && r.preset === '24h') {
      picked.current = undefined;
      update({ window: undefined });
      return;
    }
    const window = toWindow(r, Date.now());
    picked.current = { range: r, key: formatTimeRange(window) };
    update({ window });
  };
  const onSort = (next: TableSort | undefined) =>
    update({ sort: next && SORTABLE.includes(next.key) ? { key: next.key as TraceSort, order: next.order } : undefined });

  const rows = traces.data?.traces ?? [];
  const agentRows = agents.data ?? [];
  const facets = [
    agentFacet(agentRows, state.agent, setText('agent')),
    facet('status', 'Status', STATUSES, state.status, setText('status')),
    facet('model', 'Model', uniqueSorted(rows.map((t) => t.model)), state.model, setText('model')),
    facet('project', 'Project', uniqueSorted(agentRows.map((a) => a.project)), state.project, setText('project')),
  ];
  if (traces.error instanceof ObserveDaemonDownError) return <ObserveDaemonDown />;

  return (
    <section className="traces-screen" aria-label="Traces">
      <h2 className="visually-hidden">Traces</h2>
      <FilterBar
        search={{ value: state.q ?? '', onChange: (q) => setText('q')(q.trim()), placeholder: 'Search name, input or output' }}
        facets={facets}
        range={{ value: rangeValue(state, picked), onChange: onRange }}
      />
      <ObserveError error={traces.error} />
      <DataTable
        id="traces"
        columns={columns(now)}
        rows={rows}
        rowKey={(t) => t.trace_id}
        sort={state.sort && state.sort.key !== 'start' ? state.sort : undefined}
        onSortChange={onSort}
        onRowOpen={(t) => navigate(`/traces/${encodeURIComponent(t.trace_id)}`)}
        page={{ offset: state.offset, limit: PAGE_SIZE, total: traces.data?.total ?? 0, onChange: (offset) => update({ offset }) }}
        loading={traces.loading}
        empty={
          <EmptyState
            title="No traces match these filters"
            hint="Traces appear once an agent with LOUSHO_OBSERVE=1 finishes a run. Try a wider time range."
          />
        }
      />
    </section>
  );
}

/** `#/traces`, behind the daemon-down state. */
export function TracesScreen() {
  const health = useDaemonHealth();
  return health.down ? <ObserveDaemonDown /> : <TracesList />;
}
