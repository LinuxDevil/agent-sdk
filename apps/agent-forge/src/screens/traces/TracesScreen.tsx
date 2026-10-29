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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Radio, RefreshCw, SearchX, X } from 'lucide-react';
import { navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useAgents, useDaemonDown, useDaemonHealth, useTraces } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import type { TraceSort } from '../../observe/observeClient';
import type { ObserveAgentRow, ObserveTraceRow } from '../../observe/types';
import { fmtCost, fmtDuration, fmtInt, fmtStarted } from '../../observe/format';
import { Card } from '../../ui/Card';
import { DataTable, ErrorCell, type Column, type TableSort } from '../../ui/DataTable';
import { FilterBar } from '../../ui/FilterBar';
import { EmptyState } from '../../ui/EmptyState';
import { StatusPill } from '../../ui/StatusPill';
import { ScreenHeader } from '../../shell/ScreenHeader';
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

/** How often the Live toggle re-fetches the list. */
const LIVE_POLL_MS = 5000;

/** The name cell: the run name (500) over the agent and the trace id (mono, faint). */
function NameCell({ trace }: { trace: ObserveTraceRow }) {
  const name = trace.name ?? trace.trace_id.slice(0, 12);
  const agent = trace.agent_name ?? trace.agent_id;
  return (
    <span className="traces-name">
      <span className="traces-name-title" title={name}>
        {name}
      </span>
      <span className="traces-name-meta">
        {agent && <span className="traces-name-agent">{agent}</span>}
        <span className="traces-name-id" title={trace.trace_id}>
          {trace.trace_id}
        </span>
      </span>
    </span>
  );
}

/** The model as a small mono chip, the full name in its tooltip. */
function ModelChip({ model }: { model: string | null }) {
  if (!model) return null;
  return (
    <span className="traces-model-chip" title={model}>
      {model}
    </span>
  );
}

/** A failed run's error: danger text behind an alert icon (the kit's ErrorCell). */
function TraceError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <span className="traces-error" title={message}>
      <ErrorCell>{message}</ErrorCell>
    </span>
  );
}

/**
 * The list's columns, sized so the table fits a 1280 px window with the nav
 * expanded (and the header stays sticky): the agent and trace id ride under
 * the name, the error takes the flexible width; the agent column and the
 * output preview appear on wider screens, and a phone keeps status and name
 * (the status pill flags errors).
 */
function columns(now: number): Column<ObserveTraceRow>[] {
  return [
    { key: 'status', header: 'Status', width: 82, render: (t) => <StatusPill status={t.status} /> },
    { key: 'name', header: 'Name', width: 176, render: (t) => <NameCell trace={t} /> },
    { key: 'agent', header: 'Agent', width: 130, hideBelow: 1360, render: (t) => <Clip text={t.agent_name ?? t.agent_id} /> },
    { key: 'input', header: 'Input', width: 124, hideBelow: 900, render: (t) => <Clip text={t.input_preview} /> },
    { key: 'output', header: 'Output', minWidth: 120, hideBelow: 1500, render: (t) => <Clip text={t.output_preview} /> },
    { key: 'error', header: 'Error', minWidth: 120, hideBelow: 560, render: (t) => <TraceError message={t.error_message} /> },
    { key: 'model', header: 'Model', width: 116, hideBelow: 760, render: (t) => <ModelChip model={t.model} /> },
    { key: 'started', header: 'Started', width: 80, hideBelow: 640, render: (t) => <span className="traces-num">{fmtStarted(t.start, now)}</span> },
    { key: 'duration', header: 'Duration', align: 'right', sortable: true, width: 90, hideBelow: 420, render: (t) => fmtDuration(t.end - t.start) },
    {
      key: 'tokens',
      header: 'Tokens',
      align: 'right',
      sortable: true,
      width: 86,
      hideBelow: 600,
      render: (t) => (
        <span title={`${fmtInt(t.input_tokens)} in / ${fmtInt(t.output_tokens)} out`}>
          {fmtInt(t.input_tokens + t.output_tokens)}
        </span>
      ),
    },
    { key: 'cost', header: 'Cost', align: 'right', sortable: true, width: 84, hideBelow: 600, render: (t) => fmtCost(t.cost_usd) },
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
        <X size={14} strokeWidth={1.75} aria-hidden="true" />
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

interface TracesListProps {
  /** Bumped by Refresh and each Live tick: re-fetches and moves the rolling window's end to now. */
  refreshKey: number;
  /** True while Live polls; its re-fetches keep the rows as they are instead of dimming them. */
  live: boolean;
  /** Called when the list finds the daemon down, so Live stops. */
  onDown: () => void;
}

function TracesList({ refreshKey, live, onDown }: TracesListProps) {
  const route = useRoute();
  const queryString = route.query.toString();
  const state = useMemo(() => parseTracesQuery(route.query), [queryString]);
  // One "now" per URL (and per refresh), so the rolling default window doesn't refetch every render.
  const now = useMemo(() => Date.now(), [queryString, refreshKey]);
  const filter = useMemo(() => toTraceFilter(state, now), [state, now]);
  const traces = useTraces(filter, refreshKey);
  const agents = useAgents();
  const down = useDaemonDown(false, [traces, agents]);
  useEffect(() => {
    if (down) onDown();
  }, [down, onDown]);

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
      <Card as="div" padding="none" className="traces-card">
        <DataTable
          id="traces"
          columns={columns(now)}
          rows={rows}
          rowKey={(t) => t.trace_id}
          sort={tableSort(state.sort)}
          onSortChange={onSort}
          onRowOpen={(t) => navigate(`/traces/${encodeURIComponent(t.trace_id)}`)}
          page={{ offset: state.offset, limit: PAGE_SIZE, total: totalOf(traces.data), onChange: (offset) => update({ offset }) }}
          density="comfortable"
          loading={traces.loading && !(live && rows.length > 0)}
          empty={
            <EmptyState
              icon={SearchX}
              title="No traces match these filters"
              hint="Traces appear once an agent with LOUSHO_OBSERVE=1 finishes a run. Try a wider time range."
            />
          }
        />
      </Card>
    </section>
  );
}

interface ListActionsProps {
  live: boolean;
  disabled: boolean;
  onRefresh: () => void;
  onLive: () => void;
}

/** Refresh (an icon button) and the Live toggle, for the page header. */
function ListActions({ live, disabled, onRefresh, onLive }: ListActionsProps) {
  return (
    <>
      <button type="button" className="btn btn-icon" aria-label="Refresh" title="Refresh" disabled={disabled} onClick={onRefresh}>
        <RefreshCw aria-hidden="true" />
      </button>
      <button
        type="button"
        className={live ? 'btn traces-live on' : 'btn traces-live'}
        aria-pressed={live}
        title={live ? 'Refreshing every 5 seconds' : 'Refresh every 5 seconds'}
        disabled={disabled}
        onClick={onLive}
      >
        <Radio aria-hidden="true" />
        Live
      </button>
    </>
  );
}

/**
 * `#/traces`, behind the daemon-down state, under its page header: Refresh
 * re-fetches now; Live (component state, off by default) re-fetches every 5 s
 * until it is switched off, the screen unmounts or the daemon goes down.
 */
export function TracesScreen() {
  const health = useDaemonHealth();
  const [live, setLive] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);
  const stopLive = useCallback(() => setLive(false), []);
  useEffect(() => {
    if (health.down) setLive(false);
  }, [health.down]);
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(bump, LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [live, bump]);
  return (
    <>
      <ScreenHeader
        title="Traces"
        description="Every run reported to the collector"
        actions={<ListActions live={live} disabled={health.down} onRefresh={bump} onLive={() => setLive((on) => !on)} />}
      />
      {health.down ? <ObserveDaemonDown /> : <TracesList refreshKey={refreshKey} live={live} onDown={stopLive} />}
    </>
  );
}
