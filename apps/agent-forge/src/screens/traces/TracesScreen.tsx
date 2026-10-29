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
import { useEffect, useMemo } from 'react';
import { navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useAgents, useDaemonDown, useDaemonHealth, useTraces } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import type { TraceSort } from '../../observe/observeClient';
import type { ObserveAgentRow, ObserveTraceRow } from '../../observe/types';
import { fmtCost, fmtDuration, fmtInt, fmtStarted } from '../../observe/format';
import { DataTable, type Column, type TableSort } from '../../ui/DataTable';
import { FilterBar } from '../../ui/FilterBar';
import { EmptyState } from '../../ui/EmptyState';
import { StatusPill } from '../../ui/StatusPill';
import { Clip, agentFacet, facet, useRangeFilter } from '../listFilters';
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
      render: (t) => <Clip text={t.error_message} className="list-clip traces-error" />,
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

const uniqueSorted = (values: (string | null | undefined)[]): string[] =>
  [...new Set(values.filter((v): v is string => Boolean(v)))].sort();

/** The `prompt` filter (set by the Prompts screen's runs link; no facet edits it), removable in place. */
function PromptChip({ prompt, onRemove }: { prompt: string | undefined; onRemove: () => void }) {
  if (!prompt) return null;
  return (
    <p className="traces-prompt-chip">
      <span>Prompt: {prompt}</span>
      <button type="button" className="traces-prompt-remove" aria-label={`Remove prompt filter ${prompt}`} onClick={onRemove}>
        ×
      </button>
    </p>
  );
}

const toSort = (next: TableSort | undefined): TracesUrlState['sort'] =>
  next && SORTABLE.includes(next.key) ? { key: next.key as TraceSort, order: next.order } : undefined;

/** The agent / status / model / project facets; model options come from the rows on screen. */
function traceFacets(
  state: TracesUrlState,
  rows: ObserveTraceRow[],
  agentRows: ObserveAgentRow[],
  setText: (key: 'agent' | 'status' | 'model' | 'project') => (v: string | undefined) => void
) {
  return [
    agentFacet(agentRows, state.agent, setText('agent')),
    facet('status', 'Status', STATUSES, state.status, setText('status')),
    facet('model', 'Model', uniqueSorted(rows.map((t) => t.model)), state.model, setText('model')),
    facet('project', 'Project', uniqueSorted(agentRows.map((a) => a.project)), state.project, setText('project')),
  ];
}

const orUndefined = (v: string | undefined): string | undefined => v || undefined;
const rowsOf = (data: { traces: ObserveTraceRow[] } | undefined): ObserveTraceRow[] => data?.traces ?? [];
const totalOf = (data: { total: number } | undefined): number => data?.total ?? 0;
const agentsOf = (data: ObserveAgentRow[] | undefined): ObserveAgentRow[] => data ?? [];
const tableSort = (sort: TracesUrlState['sort']): TracesUrlState['sort'] => (sort && sort.key !== 'start' ? sort : undefined);

function TracesList() {
  const route = useRoute();
  const queryString = route.query.toString();
  const state = useMemo(() => parseTracesQuery(route.query), [queryString]);
  // One "now" per URL, so the rolling default window doesn't refetch every render.
  const now = useMemo(() => Date.now(), [queryString]);
  const filter = useMemo(() => toTraceFilter(state, now), [state, now]);
  const traces = useTraces(filter);
  const agents = useAgents();
  const down = useDaemonDown(false, [traces, agents]);

  useEffect(() => rememberListQuery(formatTracesQuery(state)), [state]);

  // Every filter edit restarts at the first page; replace keeps Back off the filter edits.
  const update = (patch: Partial<TracesUrlState>) =>
    navigate(`/traces${formatTracesQuery({ ...state, offset: 0, ...patch })}`, { replace: true });
  const setText = (key: 'agent' | 'status' | 'model' | 'project' | 'q' | 'prompt') => (v: string | undefined) => update({ [key]: orUndefined(v) });

  const range = useRangeFilter(state.window, '24h', (window) => update({ window }));
  const onSort = (next: TableSort | undefined) => update({ sort: toSort(next) });

  const rows = rowsOf(traces.data);
  const facets = traceFacets(state, rows, agentsOf(agents.data), setText);
  if (down) return <ObserveDaemonDown />;

  return (
    <section className="traces-screen" aria-label="Traces">
      <h2 className="visually-hidden">Traces</h2>
      <FilterBar
        search={{ value: state.q ?? '', onChange: (q) => setText('q')(q.trim()), placeholder: 'Search name, input or output' }}
        facets={facets}
        range={range}
      />
      <PromptChip prompt={state.prompt} onRemove={() => setText('prompt')(undefined)} />
      <ObserveError error={traces.error} />
      <DataTable
        id="traces"
        columns={columns(now)}
        rows={rows}
        rowKey={(t) => t.trace_id}
        sort={tableSort(state.sort)}
        onSortChange={onSort}
        onRowOpen={(t) => navigate(`/traces/${encodeURIComponent(t.trace_id)}`)}
        page={{ offset: state.offset, limit: PAGE_SIZE, total: totalOf(traces.data), onChange: (offset) => update({ offset }) }}
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
